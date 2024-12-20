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

app.post("/fulfillment", async (req: Request, res: Response) => {
  console.log("=== Fulfillment recebido do Dialogflow ===");
  const intentName = req.body.queryResult.intent.displayName;
  console.log("Intenção disparada:", intentName);
  const sessionPath: string = req.body.session || "";
  const sessionId = sessionPath.split("/").pop() || "";
  const userQuery = req.body.queryResult.queryText;
  console.log("Texto do usuário:", userQuery);
  const audioUrl = req.body.originalDetectIntentRequest?.payload?.audioUrl;

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

  console.log("Estado atual:", state);

  let responseText = "Desculpe, não entendi sua solicitação.";
  let finalUserInput = userQuery;

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
            console.log("Horários limitados a 4:", availableSlots);
            responseText = `Os horários disponíveis são:\n${availableSlots
              .map((s: string, i: number) => `${i + 1} - ${s}`)
              .join(
                "\n"
              )}\n\nPor favor, responda com o número do horário desejado. Caso queira cadastrar uma consulta manualmente, responda com 0.`;
            state = "AWAITING_SLOT_SELECTION";
          }
        } else if (state === "AWAITING_SLOT_SELECTION") {
          console.log("Estado AWAITING_SLOT_SELECTION. Verificando número...");
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
        } else if (state === "AWAITING_MANUAL_DATE_TIME") {
          console.log(
            "Estado AWAITING_MANUAL_DATE_TIME. Armazenando data/hora manual..."
          );
          chosenSlot = finalUserInput;
          console.log("Data/hora manual:", chosenSlot);
          responseText =
            "Certo, agora, por favor, informe o seu nome completo.";
          state = "AWAITING_NAME";
        } else if (state === "AWAITING_NAME") {
          console.log("Estado AWAITING_NAME. Armazenando nome...");
          clientName = finalUserInput;
          console.log("Nome:", clientName);
          responseText = "Agora, informe seu e-mail, por favor.";
          state = "AWAITING_EMAIL";
        } else if (state === "AWAITING_EMAIL") {
          console.log("Estado AWAITING_EMAIL. Armazenando e-mail...");
          clientEmail = finalUserInput;
          console.log("E-mail:", clientEmail);
          responseText = "Agora, informe seu número de telefone, por favor.";
          state = "AWAITING_PHONE";
        } else if (state === "AWAITING_PHONE") {
          console.log("Estado AWAITING_PHONE. Armazenando telefone...");
          clientPhone = finalUserInput;
          console.log("Telefone:", clientPhone);
          responseText = `Por favor, confirme os dados:\nNome: ${clientName}\nE-mail: ${clientEmail}\nTelefone: ${clientPhone}\nData/Horário: ${chosenSlot}\n\nConfirma? (sim/não)`;
          state = "AWAITING_CONFIRMATION";
        } else if (state === "AWAITING_CONFIRMATION") {
          console.log(
            "Estado AWAITING_CONFIRMATION. Verificando confirmação..."
          );
          if (finalUserInput.toLowerCase() === "sim") {
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
          } else {
            console.log("Usuário não confirmou. Encerrando sem marcar.");
            responseText =
              "Ok, a consulta não foi marcada. Caso queira tentar novamente, diga 'Marcar Consulta'.";
            state = "FINISHED";
          }
        } else {
          console.log("Estado desconhecido ou FINISHED. Encerrando fluxo.");
          responseText =
            "Não entendi sua solicitação. Por favor, diga 'Marcar Consulta' para recomeçar.";
          state = "FINISHED";
        }
        break;
      }

      case "saudacoes_e_boas_vindas":
        console.log("Intenção saudacoes_e_boas_vindas acionada.");
        responseText = `Seja bem-vinda(o) ao consultório da *Nutri Materno-Infantil Sabrina Lagos*❕\n\n🛜 Aproveite e conheça melhor o trabalho da Nutri pelo Instagram: *@nutrisabrina.lagos*\nhttps://www.instagram.com/nutrisabrina.lagos\n\n*Dicas* para facilitar a nossa comunicação:\n📵 Esse número não atende ligações;\n🚫 Não ouvimos áudios;\n⚠️ Respondemos por ordem de recebimento da mensagem, por isso evite enviar a mesma mensagem mais de uma vez para não voltar ao final da fila.\n\nMe conta como podemos te ajudar❓`;
        break;

      case "introducao_alimentar":
        console.log("Intenção introducao_alimentar acionada.");
        responseText = `Vou te explicar direitinho como funciona o acompanhamento nutricional da Dra Sabrina, ok? 😉\n\nA Dra Sabrina vai te ajudar com a introdução alimentar do seu bebê explicando como preparar os alimentos, quais alimentos devem ou não ser oferecidos nessa fase e de quais formas oferecê-los, dentre outros detalhes.\n\n🔹 *5 a 6 meses*: Orientações para iniciar a alimentação.\n🔹 *7 meses*: Introdução dos alimentos alergênicos e aproveitamento da janela imunológica.\n🔹 *9 meses*: Evolução das texturas dos alimentos.\n🔹 *12 meses*: Check-up e orientações para transição à alimentação da família.\n\nDurante 30 dias após a consulta, você pode tirar dúvidas pelo chat do app. A Dra. responde semanalmente.`;
        break;

      default:
        console.log(
          "Intenção não mapeada, enviando mensagem para o ChatGPT..."
        );
        console.log("Mensagem enviada:", finalUserInput);
        responseText = await getOpenAiCompletion(finalUserInput);
        console.log("Resposta do GPT:", responseText);
    }

    const responseJson: any = {
      fulfillmentText: responseText,
    };

    console.log("Novo estado:", state);
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
      responseJson.outputContexts = [];
    }

    console.log("Resposta enviada ao Dialogflow:", responseJson);
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
    const sessionId = uuidv4();

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
