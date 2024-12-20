import "dotenv/config";
import express from "express";
import { Request, Response } from "express";
import bodyParser from "body-parser";
import axios from "axios";
import { GoogleAuth } from "google-auth-library";
import { google } from "googleapis";
import * as dateFnsTz from "date-fns-tz";
import qs from "qs";
import { transcribeAudio, getOpenAiCompletion } from "./services/openai";
import { v4 as uuidv4 } from "uuid";

const toZonedTime = dateFnsTz.toZonedTime;
const format = dateFnsTz.format;

const credentialsJson = process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON;
if (!credentialsJson) {
  throw new Error("As credenciais do Google não estão definidas.");
}
const parsedCredentials = JSON.parse(credentialsJson);

const accountSid = process.env.TWILIO_ACCOUNT_SID;
const authToken = process.env.TWILIO_AUTH_TOKEN;
const twilioFromNumber = process.env.TWILIO_PHONE_NUMBER;

const auth = new GoogleAuth({
  credentials: parsedCredentials,
  scopes: [
    "https://www.googleapis.com/auth/dialogflow",
    "https://www.googleapis.com/auth/calendar",
    "https://www.googleapis.com/auth/calendar.events",
  ],
});

const DIALOGFLOW_PROJECT_ID = process.env.DIALOGFLOW_PROJECT_ID;

const app = express();
app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());

const calendar = google.calendar({ version: "v3", auth });

function dividirMensagem(mensagem: string, tamanhoMax = 1600): string[] {
  const partes: string[] = [];
  for (let i = 0; i < mensagem.length; i += tamanhoMax) {
    partes.push(mensagem.substring(i, i + tamanhoMax));
  }
  return partes;
}

async function getAvailableSlots(
  calendarId: string,
  weeksToSearch = 2
): Promise<string[]> {
  const timeIncrement = 60;
  const timeZone = "America/Sao_Paulo";
  let startDate = new Date();
  let endDate = new Date();
  endDate.setDate(startDate.getDate() + weeksToSearch * 7);

  try {
    const response = await calendar.events.list({
      calendarId,
      timeMin: startDate.toISOString(),
      timeMax: endDate.toISOString(),
      singleEvents: true,
      orderBy: "startTime",
    });

    const events = response.data.items || [];
    const freeSlots: string[] = [];
    let currentDate = toZonedTime(startDate, timeZone);

    while (currentDate < endDate) {
      const dayOfWeek = currentDate.getDay();

      let startHour = 0;
      let endHour = 0;

      // Terça: 14-19, Quarta: 8-13
      if (dayOfWeek === 2) {
        startHour = 14;
        endHour = 19;
      } else if (dayOfWeek === 3) {
        startHour = 8;
        endHour = 13;
      } else {
        currentDate.setDate(currentDate.getDate() + 1);
        currentDate = toZonedTime(currentDate, timeZone);
        continue;
      }

      currentDate.setHours(startHour, 0, 0, 0);

      while (currentDate.getHours() < endHour) {
        const now = toZonedTime(new Date(), timeZone);
        if (currentDate <= now) {
          currentDate.setMinutes(currentDate.getMinutes() + timeIncrement);
          continue;
        }

        const isFree = !events.some((event) => {
          const eventStart = event.start?.dateTime
            ? toZonedTime(new Date(event.start.dateTime), timeZone)
            : null;
          const eventEnd = event.end?.dateTime
            ? toZonedTime(new Date(event.end.dateTime), timeZone)
            : null;
          return (
            eventStart &&
            eventEnd &&
            currentDate >= eventStart &&
            currentDate < eventEnd
          );
        });

        if (isFree) {
          freeSlots.push(format(currentDate, "dd/MM/yyyy HH:mm", { timeZone }));
        }

        currentDate.setMinutes(currentDate.getMinutes() + timeIncrement);
      }

      currentDate.setDate(currentDate.getDate() + 1);
      currentDate = toZonedTime(currentDate, timeZone);
    }

    return freeSlots;
  } catch (error) {
    console.error("Erro ao buscar horários disponíveis:", error);
    throw new Error("Erro ao buscar horários disponíveis");
  }
}

async function createEvent(
  calendarId: string,
  chosenSlot: string,
  clientName: string,
  clientEmail: string,
  clientPhone: string
) {
  const timeZone = "America/Sao_Paulo";
  // chosenSlot no formato "dd/MM/yyyy HH:mm"
  const [datePart, timePart] = chosenSlot.split(" ");
  const [day, month, year] = datePart.split("/");
  const [hour, minute] = timePart.split(":");

  const isoStartDateTime = `${year}-${month}-${day}T${hour}:${minute}:00`;
  const isoEndDateTime = `${year}-${month}-${day}T${String(
    parseInt(hour, 10) + 1
  ).padStart(2, "0")}:${minute}:00`;

  const event = {
    summary: "Consulta",
    description: `Consulta para ${clientName}. Contato: ${clientEmail}, ${clientPhone}`,
    start: { dateTime: isoStartDateTime, timeZone },
    end: { dateTime: isoEndDateTime, timeZone },
  };

  await calendar.events.insert({
    calendarId,
    requestBody: event,
  });
}

app.post("/fulfillment", async (req: Request, res: Response) => {
  const intentName = req.body.queryResult.intent.displayName;
  const sessionPath: string = req.body.session || "";
  const sessionId = sessionPath.split("/").pop() || "";
  const userQuery = req.body.queryResult.queryText;
  const audioUrl = req.body.originalDetectIntentRequest?.payload?.audioUrl;

  // Extrair contexto e parâmetros
  const outputContexts = req.body.queryResult.outputContexts || [];
  // Buscamos o contexto marcar_consulta_flow
  const flowContext = outputContexts.find((ctx: any) =>
    ctx.name.endsWith("marcar_consulta_flow")
  );

  // Ler parâmetros do contexto (ou padrão)
  let state = flowContext?.parameters?.state || "INITIAL";
  let chosenSlot = flowContext?.parameters?.chosenSlot || "";
  let clientName = flowContext?.parameters?.clientName || "";
  let clientEmail = flowContext?.parameters?.clientEmail || "";
  let clientPhone = flowContext?.parameters?.clientPhone || "";
  let availableSlots = flowContext?.parameters?.availableSlots || [];

  let responseText = "Desculpe, não entendi sua solicitação.";
  let finalUserInput = userQuery;

  // Transcrição de áudio se necessário
  if (audioUrl) {
    try {
      console.log("Áudio recebido. Iniciando transcrição...");
      finalUserInput = await transcribeAudio(audioUrl);
      console.log("Transcrição concluída:", finalUserInput);
    } catch (audioError) {
      console.error("Erro ao transcrever o áudio:", audioError);
      responseText = "Não consegui entender o áudio enviado. Tente novamente.";
    }
  }

  try {
    switch (intentName) {
      case "Marcar Consulta":
        // Aqui gerenciamos o fluxo usando o state
        {
          const calendarId = "jurami.junior@gmail.com";

          // Se ainda não temos availableSlots, busque-os na fase INITIAL
          if (state === "INITIAL") {
            const fetchedSlots = await getAvailableSlots(calendarId);
            if (fetchedSlots.length === 0) {
              responseText =
                "Não há horários disponíveis no momento. Por favor, tente novamente mais tarde.";
              state = "FINISHED";
            } else {
              availableSlots = fetchedSlots.slice(0, 4);
              responseText = `Os horários disponíveis são:\n${availableSlots
                .map((s: string, i: number) => `${i + 1} - ${s}`)
                .join(
                  "\n"
                )}\n\nPor favor, responda com o número do horário desejado. Caso queira cadastrar uma consulta manualmente, responda com 0.`;
              state = "AWAITING_SLOT_SELECTION";
            }
          } else if (state === "AWAITING_SLOT_SELECTION") {
            // O usuário deve ter digitado um número (0 a 4)
            const userNumber = parseInt(finalUserInput, 10);
            if (!isNaN(userNumber) && userNumber >= 0 && userNumber <= 4) {
              if (userNumber === 0) {
                responseText =
                  "Ok, vamos cadastrar a consulta manualmente. Por favor, informe a data e horário desejado (no formato DD/MM/YYYY HH:mm).";
                state = "AWAITING_MANUAL_DATE_TIME";
              } else {
                const slotIndex = userNumber - 1;
                if (slotIndex >= 0 && slotIndex < availableSlots.length) {
                  chosenSlot = availableSlots[slotIndex];
                  responseText =
                    "Ótimo! Agora, por favor, informe o seu nome completo.";
                  state = "AWAITING_NAME";
                } else {
                  responseText =
                    "Opção inválida. Por favor, escolha um número válido.";
                }
              }
            } else {
              responseText = "Por favor, responda com um número de 1 a 4 ou 0.";
            }
          } else if (state === "AWAITING_MANUAL_DATE_TIME") {
            // Usuário forneceu a data/hora manualmente
            chosenSlot = finalUserInput;
            responseText =
              "Certo, agora, por favor, informe o seu nome completo.";
            state = "AWAITING_NAME";
          } else if (state === "AWAITING_NAME") {
            clientName = finalUserInput;
            responseText = "Agora, informe seu e-mail, por favor.";
            state = "AWAITING_EMAIL";
          } else if (state === "AWAITING_EMAIL") {
            clientEmail = finalUserInput;
            responseText = "Agora, informe seu número de telefone, por favor.";
            state = "AWAITING_PHONE";
          } else if (state === "AWAITING_PHONE") {
            clientPhone = finalUserInput;
            // Mostrar resumo e pedir confirmação
            responseText = `Por favor, confirme os dados:\nNome: ${clientName}\nE-mail: ${clientEmail}\nTelefone: ${clientPhone}\nData/Horário: ${chosenSlot}\n\nConfirma? (sim/não)`;
            state = "AWAITING_CONFIRMATION";
          } else if (state === "AWAITING_CONFIRMATION") {
            if (finalUserInput.toLowerCase() === "sim") {
              await createEvent(
                calendarId,
                chosenSlot,
                clientName,
                clientEmail,
                clientPhone
              );
              responseText = "Sua consulta foi marcada com sucesso!";
              state = "FINISHED";
            } else {
              responseText =
                "Ok, a consulta não foi marcada. Caso queira tentar novamente, diga 'Marcar Consulta'.";
              state = "FINISHED";
            }
          } else {
            // Estado final ou desconhecido
            responseText =
              "Não entendi sua solicitação. Por favor, diga 'Marcar Consulta' para recomeçar.";
            state = "FINISHED";
          }
        }
        break;

      // Mantemos suas outras intents conforme necessário
      case "Horários Disponíveis":
        // ... (código original desta intent, se ainda necessário)
        responseText = "Você pode agora dizer 'Marcar Consulta' para iniciar.";
        break;

      case "Selecionar Horário":
        // ... (Se não for mais necessário, pode remover)
        responseText =
          "Agora usamos o fluxo na mesma intent, não use mais esta.";
        break;

      case "saudacoes_e_boas_vindas":
        responseText = `Seja bem-vinda(o) ... (mensagem original)`;
        break;

      case "introducao_alimentar":
        responseText = `Explicação sobre introdução alimentar ... (mensagem original)`;
        break;

      default:
        console.log("Enviando mensagem para o ChatGPT...");
        console.log("Mensagem enviada:", finalUserInput);
        responseText = await getOpenAiCompletion(finalUserInput);
        console.log("Resposta do GPT:", responseText);
    }

    // Montar a resposta com contexto
    const responseJson: any = {
      fulfillmentText: responseText,
    };

    // Se não tiver acabado o fluxo, manter o contexto
    if (state !== "FINISHED") {
      responseJson.outputContexts = [
        {
          name: `projects/${DIALOGFLOW_PROJECT_ID}/agent/sessions/${sessionId}/contexts/marcar_consulta_flow`,
          lifespanCount: 5,
          parameters: {
            state,
            chosenSlot,
            clientName,
            clientEmail,
            clientPhone,
            availableSlots,
          },
        },
      ];
    } else {
      // Ao finalizar, removemos o contexto para encerrar o fluxo
      responseJson.outputContexts = [];
    }

    if (!res.headersSent) {
      res.json(responseJson);
    }
  } catch (error) {
    console.error("Erro no Fulfillment:", error);
    if (!res.headersSent) {
      res.status(500).send("Erro ao processar a intenção.");
    }
  }
});

app.post("/webhook", async (req: Request, res: Response): Promise<void> => {
  try {
    if (
      !req.body ||
      (!req.body.From && !req.body.Body && !req.body.MediaUrl0)
    ) {
      res.status(400).send("Requisição inválida.");
      return;
    }

    const fromNumber = req.body.From;
    const incomingMessage = req.body.Body || "";
    const audioUrl = req.body.MediaUrl0; // URL do áudio enviado pelo Twilio
    const sessionId = uuidv4();
    const client = await auth.getClient();
    const accessToken = await client.getAccessToken();

    let finalUserMessage = incomingMessage;

    if (audioUrl) {
      try {
        console.log(`Áudio detectado. Transcrevendo áudio da URL: ${audioUrl}`);
        finalUserMessage = await transcribeAudio(audioUrl);
        console.log(`Transcrição do áudio: ${finalUserMessage}`);
      } catch (error) {
        console.error("Erro ao transcrever o áudio:", error);
        res.status(500).send("Erro ao processar o áudio enviado.");
        return;
      }
    }

    const dialogflowResponse = await axios.post(
      `https://dialogflow.googleapis.com/v2/projects/${DIALOGFLOW_PROJECT_ID}/agent/sessions/${sessionId}:detectIntent`,
      {
        queryInput: {
          text: { text: finalUserMessage, languageCode: "pt-BR" },
        },
      },
      { headers: { Authorization: `Bearer ${accessToken.token}` } }
    );

    const fullResponseMessage =
      dialogflowResponse.data.queryResult.fulfillmentText ||
      "Desculpe, não entendi.";

    const partesMensagem = dividirMensagem(fullResponseMessage);
    for (const parte of partesMensagem) {
      const url = `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Messages.json`;
      const data = {
        To: fromNumber,
        From: `whatsapp:${twilioFromNumber}`,
        Body: parte,
      };

      await axios.post(url, qs.stringify(data), {
        auth: { username: accountSid || "", password: authToken || "" },
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
      });
    }

    res.status(200).send("Mensagem processada com sucesso.");
  } catch (error) {
    console.error("Erro ao processar a mensagem:", error);
    res.status(500).send("Erro ao processar a mensagem.");
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Servidor rodando na porta ${PORT}`);
});
