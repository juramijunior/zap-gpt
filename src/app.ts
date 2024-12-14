import "dotenv/config";
import express, { Request, Response } from "express";
import bodyParser from "body-parser";
import axios from "axios";
import { GoogleAuth } from "google-auth-library";
import { google } from "googleapis";
import * as uuid from "uuid";
import * as dateFnsTz from "date-fns-tz";
import qs from "qs";

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
if (!twilioFromNumber) {
  console.error(
    "A variável TWILIO_PHONE_NUMBER não está definida. Defina esta variável de ambiente."
  );
}

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

const sessionUserMap: { [key: string]: string } = {};

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
        const isFree = !events.some((event) => {
          const eventStart = event.start?.dateTime
            ? toZonedTime(new Date(event.start.dateTime), timeZone)
            : null;
          const eventEnd = event.end?.dateTime
            ? toZonedTime(new Date(event.end.dateTime), timeZone)
            : null;

          if (!eventStart || !eventEnd) {
            return false;
          }
          return currentDate >= eventStart && currentDate < eventEnd;
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

app.post("/fulfillment", async (req: Request, res: Response) => {
  const intentName = req.body.queryResult.intent.displayName;
  const sessionPath: string = req.body.session || "";
  const sessionId = sessionPath.split("/").pop() || "";

  let responseText = "Desculpe, não entendi sua solicitação.";

  try {
    switch (intentName) {
      case "Selecionar Horário": {
        const slotNumber = req.body.queryResult.parameters?.number;

        console.log(
          "Parâmetros recebidos no webhook:",
          req.body.queryResult.parameters
        );

        if (!slotNumber || isNaN(parseInt(slotNumber))) {
          res.json({
            fulfillmentText:
              "Por favor, envie apenas o número correspondente ao horário desejado.",
          });
          return;
        }

        const slotIndex = parseInt(slotNumber) - 1;
        const calendarId = "jurami.junior@gmail.com";
        const availableSlots = await getAvailableSlots(calendarId);

        if (slotIndex < 0 || slotIndex >= availableSlots.length) {
          responseText =
            "O número escolhido está fora da lista de horários disponíveis. Por favor, tente novamente.";
          break;
        }

        const selectedSlot = availableSlots[slotIndex];
        const selectedDateTime = new Date(selectedSlot.replace(" ", "T"));

        const event = {
          summary: "Consulta",
          description: "Consulta médica agendada pelo sistema.",
          start: {
            dateTime: selectedDateTime.toISOString(),
            timeZone: "America/Sao_Paulo",
          },
          end: {
            dateTime: new Date(
              selectedDateTime.getTime() + 60 * 60000
            ).toISOString(),
            timeZone: "America/Sao_Paulo",
          },
        };

        try {
          await calendar.events.insert({
            calendarId,
            requestBody: event,
          });
          responseText = `Consulta marcada com sucesso para ${selectedSlot}.`;
        } catch (error) {
          console.error("Erro ao criar evento no Google Calendar:", error);
          responseText =
            "Ocorreu um erro ao tentar marcar a consulta. Por favor, tente novamente mais tarde.";
        }
        break;
      }

      case "Horários Disponíveis": {
        try {
          const calendarId = "jurami.junior@gmail.com";
          const availableSlots = await getAvailableSlots(calendarId);
          if (availableSlots.length === 0) {
            responseText =
              "Não há horários disponíveis no momento. Por favor, tente novamente mais tarde.";
          } else {
            responseText = `Os horários disponíveis são: \n${availableSlots
              .map((s, i) => `${i + 1}) ${s}`)
              .join("\n")}`;
          }
        } catch (error) {
          console.error("Erro ao obter horários:", error);
          responseText =
            "Desculpe, ocorreu um erro ao obter os horários disponíveis. Tente novamente mais tarde.";
        }
        break;
      }

      default:
        responseText = `Desculpe, não entendi sua solicitação. Poderia reformular?`;
    }

    if (!res.headersSent) {
      res.json({
        fulfillmentText: responseText,
      });
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
    if (!req.body || (!req.body.From && !req.body.Body)) {
      console.error("Requisição inválida recebida:", req.body);
      if (!res.headersSent) {
        res.status(400).send("Requisição inválida.");
      }
      return;
    }

    const fromNumber = req.body.From; // Número do usuário (WhatsApp)
    const incomingMessage = req.body.Body || ""; // Mensagem recebida do usuário

    const client = await auth.getClient();
    const accessToken = await client.getAccessToken();

    const sessionId = uuid.v4(); // Gera um ID único para a sessão do Dialogflow

    if (fromNumber) {
      sessionUserMap[sessionId] = fromNumber; // Mapeia a sessão para o número do usuário
    }

    // Envia a mensagem para o Dialogflow
    const dialogflowResponse = await axios.post(
      `https://dialogflow.googleapis.com/v2/projects/${DIALOGFLOW_PROJECT_ID}/agent/sessions/${sessionId}:detectIntent`,
      {
        queryInput: {
          text: {
            text: incomingMessage, // Mensagem recebida
            languageCode: "pt-BR", // Código de idioma
          },
        },
      },
      {
        headers: {
          Authorization: `Bearer ${accessToken.token}`,
        },
      }
    );

    // Captura a resposta do Dialogflow
    const responseMessage =
      dialogflowResponse.data.queryResult.fulfillmentText ||
      "Desculpe, não entendi. Poderia repetir?";

    // Envia a resposta do Dialogflow de volta ao usuário via Twilio
    const url = `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Messages.json`;
    const data = {
      To: fromNumber, // Número do usuário
      From: `whatsapp:${twilioFromNumber}`, // Número do Twilio
      Body: responseMessage, // Resposta a ser enviada
    };

    await axios.post(url, qs.stringify(data), {
      auth: {
        username: accountSid || "",
        password: authToken || "",
      },
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
      },
    });

    if (!res.headersSent) {
      res.status(200).send("Mensagem processada com sucesso.");
    }
  } catch (error) {
    console.error("Erro ao processar a mensagem:", error);
    if (!res.headersSent) {
      res.status(500).send("Erro ao processar a mensagem.");
    }
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Servidor rodando na porta ${PORT}`);
});
