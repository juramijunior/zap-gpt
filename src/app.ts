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
const userSessionMap: { [key: string]: string } = {};

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

// Armazena o estado da conversa por número de telefone do usuário
const conversationStateMap: { [key: string]: any } = {};

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
    console.log("Obtendo horários disponíveis do Google Calendar...");
    const response = await calendar.events.list({
      calendarId,
      timeMin: startDate.toISOString(),
      timeMax: endDate.toISOString(),
      singleEvents: true,
      orderBy: "startTime",
    });

    const events = response.data.items || [];
    console.log(`Eventos obtidos: ${events.length}`);

    const freeSlots: string[] = [];
    let currentDate = toZonedTime(startDate, timeZone);

    while (currentDate < endDate) {
      const dayOfWeek = currentDate.getDay();
      let startHour = 0;
      let endHour = 0;

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
          const slotStr = format(currentDate, "dd/MM/yyyy HH:mm", { timeZone });
          freeSlots.push(slotStr);
        }

        currentDate.setMinutes(currentDate.getMinutes() + timeIncrement);
      }

      currentDate.setDate(currentDate.getDate() + 1);
      currentDate = toZonedTime(currentDate, timeZone);
    }

    console.log(`Horários disponíveis encontrados: ${freeSlots.length}`);
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
  console.log("Criando evento no Google Calendar...");
  const timeZone = "America/Sao_Paulo";
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

  try {
    const insertResp = await calendar.events.insert({
      calendarId,
      requestBody: event,
    });
    console.log("Evento criado com sucesso:", insertResp.data);
  } catch (err) {
    console.error("Erro ao criar evento no Google Calendar:", err);
    throw err;
  }
}

app.post("/fulfillment", async (req: Request, res: Response): Promise<void> => {
  console.log("=== Fulfillment recebido do Dialogflow ===");
  const intentName = req.body.queryResult.intent.displayName;
  console.log("Intenção disparada:", intentName);
  const sessionPath: string = req.body.session || "";
  const sessionId = sessionPath.split("/").pop() || "";
  const userQuery = req.body.queryResult.queryText;
  console.log("Texto do usuário:", userQuery);

  const outputContexts = req.body.queryResult.outputContexts || [];
  const flowContext = outputContexts.find((ctx: any) =>
    ctx.name.endsWith("marcar_consulta_flow")
  );

  let state = flowContext?.parameters?.state || "INITIAL";
  let chosenSlot = flowContext?.parameters?.chosenSlot || "";
  let clientName = flowContext?.parameters?.clientName || "";
  let clientEmail = flowContext?.parameters?.clientEmail || "";
  let clientPhone = flowContext?.parameters?.clientPhone || "";
  let availableSlots = flowContext?.parameters?.availableSlots || [];
  let currentIndex = flowContext?.parameters?.currentIndex || 0;

  console.log("Estado atual:", state);

  let responseText = "Desculpe, não entendi sua solicitação.";

  try {
    switch (intentName) {
      case "Marcar Consulta": {
        const calendarId = "jurami.junior@gmail.com";

        if (state === "INITIAL") {
          console.log("Estado INITIAL. Buscando horários disponíveis...");
          const fetchedSlots = await getAvailableSlots(calendarId);

          if (fetchedSlots.length === 0) {
            responseText =
              "Não há horários disponíveis no momento. Por favor, tente novamente mais tarde.";
            state = "FINISHED";
          } else {
            availableSlots = fetchedSlots.slice(0, 4);
            currentIndex = 4;
            responseText = `Os horários disponíveis são:\n${availableSlots
              .map((s: string, i: number) => `${i + 1} - ${s}`)
              .join(
                "\n"
              )}\n\nPor favor, responda com o número do horário desejado. Caso queira consultar mais horários, responda com 0.`;
            state = "AWAITING_SLOT_SELECTION";
          }
        } else if (state === "AWAITING_SLOT_SELECTION") {
          const userNumber = parseInt(userQuery, 10);

          if (!isNaN(userNumber) && userNumber >= 0 && userNumber <= 4) {
            if (userNumber === 0) {
              console.log("Usuário pediu mais horários.");
              const fetchedSlots = await getAvailableSlots(calendarId);
              const nextSlots = fetchedSlots.slice(
                currentIndex,
                currentIndex + 4
              );

              if (nextSlots.length === 0) {
                responseText = "Não há mais horários disponíveis.";
              } else {
                availableSlots = nextSlots;
                currentIndex += 4;
                responseText = `Os próximos horários disponíveis são:\n${availableSlots
                  .map((s: string, i: number) => `${i + 1} - ${s}`)
                  .join(
                    "\n"
                  )}\n\nPor favor, responda com o número do horário desejado ou 0 para consultar mais horários.`;
              }
            } else {
              const slotIndex = userNumber - 1;
              if (slotIndex >= 0 && slotIndex < availableSlots.length) {
                chosenSlot = availableSlots[slotIndex];
                console.log("Horário escolhido:", chosenSlot);
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
        } else if (state === "AWAITING_NAME") {
          const isName = /^[a-zA-ZÀ-ÿ\s']+$/.test(userQuery.trim());
          if (!isName) {
            responseText =
              "Por favor, informe um nome válido. Exemplo: 'Meu nome é João Silva'.";
          } else {
            clientName = userQuery.replace(/meu nome é/i, "").trim();
            responseText = `Obrigada, ${clientName}. Agora, informe o seu e-mail.`;
            state = "AWAITING_EMAIL";
          }
        } else if (state === "AWAITING_EMAIL") {
          const emailPattern =
            /meu e-mail é\s*([\w.-]+@[\w.-]+\.[a-zA-Z]{2,})/i;
          const emailMatch = userQuery.match(emailPattern);

          if (!emailMatch || !emailMatch[1]) {
            responseText =
              "Por favor, informe um e-mail válido no formato correto. Exemplo: 'Meu e-mail é exemplo@dominio.com'.";
          } else {
            clientEmail = emailMatch[1].trim();
            responseText = "Agora, informe seu número de telefone, por favor.";
            state = "AWAITING_PHONE";
          }
        } else if (state === "AWAITING_PHONE") {
          const phonePattern = /meu telefone é\s*(\d{10,15})/i;
          const phoneMatch = userQuery.match(phonePattern);

          if (!phoneMatch || !phoneMatch[1]) {
            responseText =
              "Por favor, informe um número de telefone válido no formato correto. Exemplo: 'Meu telefone é 61999458613'.";
          } else {
            clientPhone = phoneMatch[1].trim();
            responseText = `Por favor, confirme os dados:\nNome: ${clientName}\nE-mail: ${clientEmail}\nTelefone: ${clientPhone}\nData/Horário: ${chosenSlot}\n\nConfirma? (sim/não)`;
            state = "AWAITING_CONFIRMATION";
          }
        } else if (state === "AWAITING_CONFIRMATION") {
          if (userQuery.toLowerCase() === "sim") {
            console.log("Usuário confirmou. Criando evento...");
            await createEvent(
              calendarId,
              chosenSlot,
              clientName,
              clientEmail,
              clientPhone
            );
            responseText = "Sua consulta foi marcada com sucesso!";
            state = "FINISHED";
          } else if (userQuery.toLowerCase() === "não") {
            responseText =
              "Consulta cancelada. Caso deseje marcar novamente, diga 'Marcar Consulta'.";
            state = "FINISHED";
          } else {
            responseText =
              "Por favor, responda apenas com 'Sim' para confirmar ou 'Não' para cancelar.";
          }
        }
        break;
      }

      case "Default Fallback Intent": {
        console.log("Caiu no fallback intent. Resetando contexto.");
        responseText =
          "Não entendi suas respostas. Vamos recomeçar. Por favor, diga 'Marcar Consulta' para iniciar novamente.";
        state = "INITIAL";
        break;
      }

      default: {
        responseText = "Desculpe, não entendi sua solicitação.";
        break;
      }
    }

    const responseJson: any = {
      fulfillmentText: responseText,
      outputContexts: [
        {
          name: `${sessionPath}/contexts/marcar_consulta_flow`,
          lifespanCount: state === "FINISHED" ? 0 : 5,
          parameters: {
            state,
            chosenSlot,
            clientName,
            clientEmail,
            clientPhone,
            availableSlots,
            currentIndex,
          },
        },
      ],
    };

    console.log("Resposta enviada ao Dialogflow:", responseJson);
    res.json(responseJson);
  } catch (error) {
    console.error("Erro no Fulfillment:", error);
    res.status(500).send("Erro ao processar a intenção.");
  }
});

app.post("/webhook", async (req: Request, res: Response): Promise<void> => {
  try {
    console.log("=== Requisição recebida no /webhook (Twilio) ===");
    if (
      !req.body ||
      (!req.body.From && !req.body.Body && !req.body.MediaUrl0)
    ) {
      console.error("Requisição inválida. Faltam parâmetros obrigatórios.");
      res.status(400).send("Requisição inválida.");
      return;
    }

    const fromNumber = req.body.From;
    const incomingMessage = req.body.Body || "";
    const audioUrl = req.body.MediaUrl0; // URL do áudio enviado pelo Twilio
    // Se já temos um sessionId para este usuário, use-o. Caso contrário, crie um novo.
    let sessionId = userSessionMap[fromNumber];
    if (!sessionId) {
      sessionId = uuidv4();
      userSessionMap[fromNumber] = sessionId;
      console.log(`Novo sessionId criado para ${fromNumber}: ${sessionId}`);
    } else {
      console.log(`Reutilizando sessionId para ${fromNumber}: ${sessionId}`);
    }

    console.log("From:", fromNumber);
    console.log("Mensagem recebida do usuário:", incomingMessage);
    console.log("Audio URL:", audioUrl);

    const client = await auth.getClient();
    const accessToken = await client.getAccessToken();

    let finalUserMessage = incomingMessage;

    // Verifica se é áudio e transcreve
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

    const currentState = conversationStateMap[fromNumber]?.state || "";
    console.log("Estado atual da conversa para o usuário:", currentState);

    // Adiciona prefixo conforme o estado
    if (
      currentState === "AWAITING_NAME" &&
      !finalUserMessage.toLowerCase().includes("meu nome é")
    ) {
      console.log("Inserindo prefixo para nome.");
      finalUserMessage = "Meu nome é " + finalUserMessage;
    } else if (
      currentState === "AWAITING_EMAIL" &&
      !finalUserMessage.toLowerCase().includes("meu e-mail é")
    ) {
      console.log("Inserindo prefixo para e-mail.");
      finalUserMessage = "Meu e-mail é " + finalUserMessage;
    } else if (
      currentState === "AWAITING_PHONE" &&
      !finalUserMessage.toLowerCase().includes("meu telefone é")
    ) {
      console.log("Inserindo prefixo para telefone.");
      finalUserMessage = "Meu telefone é " + finalUserMessage;
    }

    console.log("Mensagem final enviada ao Dialogflow:", finalUserMessage);

    const dialogflowResponse = await axios.post(
      `https://dialogflow.googleapis.com/v2/projects/${DIALOGFLOW_PROJECT_ID}/agent/sessions/${sessionId}:detectIntent`,
      {
        queryInput: {
          text: { text: finalUserMessage, languageCode: "pt-BR" },
        },
      },
      { headers: { Authorization: `Bearer ${accessToken.token}` } }
    );

    console.log(
      "Resposta do Dialogflow:",
      JSON.stringify(dialogflowResponse.data, null, 2)
    );

    const fullResponseMessage =
      dialogflowResponse.data.queryResult.fulfillmentText ||
      "Desculpe, não entendi.";

    const outputContexts =
      dialogflowResponse.data.queryResult.outputContexts || [];
    const flowContext = outputContexts.find((ctx: any) =>
      ctx.name.endsWith("marcar_consulta_flow")
    );
    let updatedState = flowContext?.parameters?.state || "";
    console.log("Novo estado retornado pelo Dialogflow:", updatedState);

    // Salva o estado para a próxima mensagem do usuário
    conversationStateMap[fromNumber] = {
      state: updatedState,
    };

    const partesMensagem = dividirMensagem(fullResponseMessage);
    for (const parte of partesMensagem) {
      console.log("Enviando parte da mensagem ao usuário:", parte);
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

    console.log("=== Resposta final enviada ao usuário via Twilio ===");
    res.status(200).send("Mensagem processada com sucesso.");
  } catch (error) {
    console.error("Erro ao processar a mensagem no /webhook:", error);
    res.status(500).send("Erro ao processar a mensagem.");
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Servidor rodando na porta ${PORT}`);
});

interface DialogflowContext {
  name: string;
  lifespanCount: number;
  parameters: { [key: string]: any };
}
