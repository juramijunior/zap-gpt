import "dotenv/config";
import express from "express";
import { Request, Response } from "express";
import bodyParser from "body-parser";
import axios from "axios";
import { GoogleAuth } from "google-auth-library";
import { google } from "googleapis";
import * as dateFnsTz from "date-fns-tz";
import qs from "qs";
import { transcribeAudio } from "./services/openai";
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

    return freeSlots;
  } catch (error) {
    throw new Error("Erro ao buscar horários disponíveis");
  }
}

async function getBookedAppointments(
  calendarId: string
): Promise<{ id: string; description: string }[]> {
  const response = await calendar.events.list({
    calendarId,
    timeMin: new Date().toISOString(),
    singleEvents: true,
    orderBy: "startTime",
  });

  const events = response.data.items || [];
  return events.map((event) => ({
    id: event.id || "",
    description: event.summary || "Sem descrição",
  }));
}

async function deleteAppointment(
  calendarId: string,
  eventId: string
): Promise<void> {
  try {
    await calendar.events.delete({
      calendarId,
      eventId,
    });
  } catch (error) {
    throw new Error("Erro ao remover consulta.");
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
    await calendar.events.insert({
      calendarId,
      requestBody: event,
    });
  } catch (err) {
    throw err;
  }
}

app.post("/fulfillment", async (req, res) => {
  const intentName = req.body.queryResult.intent.displayName;
  const sessionPath = req.body.session || "";
  const sessionId = sessionPath.split("/").pop() || "";
  const userQuery = req.body.queryResult.queryText;

  const outputContexts: {
    name: string;
    lifespanCount?: number;
    parameters?: any;
  }[] = req.body.queryResult.outputContexts || [];

  const flowContext = outputContexts.find((ctx: { name: string }) =>
    ctx.name.endsWith("marcar_consulta_flow")
  );

  let state = flowContext?.parameters?.state || "INITIAL";
  let chosenSlot = flowContext?.parameters?.chosenSlot || "";
  let clientName = flowContext?.parameters?.clientName || "";
  let clientEmail = flowContext?.parameters?.clientEmail || "";
  let clientPhone = flowContext?.parameters?.clientPhone || "";
  let availableSlots = flowContext?.parameters?.availableSlots || [];

  let responseText = "Desculpe, não entendi sua solicitação.";

  try {
    switch (intentName) {
      case "Marcar Consulta": {
        const calendarId = "jurami.junior@gmail.com";
        if (state === "INITIAL") {
          const fetchedSlots: string[] = await getAvailableSlots(calendarId); // Tipo explicitamente definido
          if (fetchedSlots.length === 0) {
            responseText = "Não há horários disponíveis no momento.";
            state = "FINISHED";
          } else {
            availableSlots = fetchedSlots.map(
              (s: string, i: number) => `${i + 1} - ${s}`
            );
            responseText = `Os horários disponíveis são:\n${availableSlots.join(
              "\n"
            )}\n\nResponda com o número do horário desejado ou 0 para mais opções.`;
            state = "AWAITING_SLOT_SELECTION";
          }
        } else if (state === "AWAITING_SLOT_SELECTION") {
          const userNumber = parseInt(userQuery, 10);
          if (userNumber === 0) {
            const currentIndex = availableSlots.length;
            const fetchedSlots = await getAvailableSlots(calendarId);
            const nextSlots = fetchedSlots.slice(
              currentIndex,
              currentIndex + 4
            );
            if (nextSlots.length > 0) {
              availableSlots = availableSlots.concat(nextSlots);
              responseText = `Próximos horários disponíveis:\n${nextSlots
                .map((s, i) => `${currentIndex + i + 1} - ${s}`)
                .join("\n")}\n\nEscolha um horário ou responda 0 para mais.`;
            } else {
              responseText = "Não há mais horários disponíveis.";
            }
          } else if (userNumber > 0 && userNumber <= availableSlots.length) {
            const slotIndex = userNumber - 1;
            chosenSlot = availableSlots[slotIndex];
            responseText = "Ótimo! Agora informe seu nome completo.";
            state = "AWAITING_NAME";
          } else {
            responseText = "Opção inválida. Escolha um número válido.";
          }
        } else if (state === "AWAITING_NAME") {
          clientName = userQuery.trim().replace(/^Meu nome é\s*/i, "");
          responseText = `Obrigada, ${clientName}. Informe o e-mail.`;
          state = "AWAITING_EMAIL";
        } else if (state === "AWAITING_EMAIL") {
          const emailPattern =
            /meu e-mail é\s*([\w.-]+@[\w.-]+\.[a-zA-Z]{2,})/i;
          const emailMatch = userQuery.match(emailPattern);
          if (emailMatch) {
            clientEmail = emailMatch[1];
            responseText = "Agora informe seu telefone.";
            state = "AWAITING_PHONE";
          } else {
            responseText = "Informe um e-mail válido no formato correto.";
          }
        } else if (state === "AWAITING_PHONE") {
          const phonePattern = /meu telefone é\s*(\d{10,15})/i;
          const phoneMatch = userQuery.match(phonePattern);
          if (phoneMatch) {
            clientPhone = phoneMatch[1];
            responseText = `Confirme os dados:\nNome: ${clientName}\nE-mail: ${clientEmail}\nTelefone: ${clientPhone}\nHorário: ${chosenSlot}\n\nConfirma? (sim/não)`;
            state = "AWAITING_CONFIRMATION";
          } else {
            responseText = "Informe um telefone válido no formato correto.";
          }
        } else if (state === "AWAITING_CONFIRMATION") {
          if (userQuery.toLowerCase() === "sim") {
            await createEvent(
              calendarId,
              chosenSlot,
              clientName,
              clientEmail,
              clientPhone
            );
            responseText = "Consulta marcada com sucesso!";
            state = "FINISHED";
          } else {
            responseText = "Consulta cancelada. Reinicie se necessário.";
            state = "FINISHED";
          }
        }
        break;
      }

      case "Consultar Consultas Marcadas": {
        console.log("Intenção 'Consultar Consultas Marcadas' acionada.");
        const consultasMarcadas = await getBookedAppointments(
          "jurami.junior@gmail.com"
        );

        if (consultasMarcadas.length === 0) {
          responseText = "Você não possui consultas marcadas no momento.";
          state = "FINISHED";
        } else {
          responseText = `Suas consultas marcadas:\n${consultasMarcadas
            .map((consulta, index) => `${index + 1} - ${consulta.description}`)
            .join("\n")}`;
        }
        break;
      }

      case "Desmarcar Consultas": {
        console.log("Intenção 'Desmarcar Consulta' acionada.");
        const consultasMarcadas: { id: string; description: string }[] =
          await getBookedAppointments("jurami.junior@gmail.com");

        if (consultasMarcadas.length === 0) {
          responseText = "Você não possui consultas marcadas no momento.";
          state = "FINISHED";
        } else {
          const availableSlots: { id: string; description: string }[] =
            consultasMarcadas.map(
              (consulta: { id: string; description: string }) => ({
                id: consulta.id,
                description: consulta.description,
              })
            );

          responseText = `Selecione a consulta que deseja desmarcar:\n${availableSlots
            .map(
              (slot: { id: string; description: string }, index: number) =>
                `${index + 1} - ${slot.description}`
            )
            .join("\n")}\n\nResponda com o número correspondente.`;
          state = "AWAITING_CANCEL_SELECTION";
        }
        break;
      }

      default:
        responseText = "Não entendi sua solicitação.";
        state = "FINISHED";
    }

    const responseJson = {
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
          },
        },
      ],
    };

    res.json(responseJson);
  } catch (error) {
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
