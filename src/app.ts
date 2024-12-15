import "dotenv/config";
import express, { Request, Response } from "express";
import bodyParser from "body-parser";
import axios from "axios";
import { GoogleAuth } from "google-auth-library";
import { google } from "googleapis";
import * as uuid from "uuid";
import * as dateFnsTz from "date-fns-tz";
import qs from "qs";
import { formatISO } from "date-fns";

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
        const isFree = !events.some((event) => {
          const eventStart = event.start?.dateTime
            ? toZonedTime(new Date(event.start.dateTime), timeZone)
            : event.start?.date
            ? toZonedTime(new Date(event.start.date), timeZone)
            : null;
          const eventEnd = event.end?.dateTime
            ? toZonedTime(new Date(event.end.dateTime), timeZone)
            : event.end?.date
            ? toZonedTime(new Date(event.end.date), timeZone)
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
      case "Horários Disponíveis":
        try {
          const calendarId = "jurami.junior@gmail.com";
          const availableSlots = await getAvailableSlots(calendarId);
          if (availableSlots.length === 0) {
            responseText =
              "Não há horários disponíveis no momento. Por favor, tente novamente mais tarde.";
          } else {
            responseText = `Os horários disponíveis são: \n${availableSlots
              .map((s, i) => `${i + 1}) ${s}`)
              .join(
                "\n"
              )}\nPor favor, responda com o número do horário desejado. Caso queira cadastrar uma consulta específica, responda com 0.`;
          }
        } catch (error) {
          console.error("Erro ao obter horários:", error);
          responseText =
            "Desculpe, ocorreu um erro ao obter os horários disponíveis. Tente novamente mais tarde.";
        }
        break;

      case "Selecionar Horário": {
        const slotNumber = req.body.queryResult.parameters?.number;
        const slotIndex = parseInt(slotNumber) - 1;
        const calendarId = "jurami.junior@gmail.com";
        const availableSlots = await getAvailableSlots(calendarId);

        if (slotIndex < 0 || slotIndex >= availableSlots.length) {
          responseText =
            "A escolha não é válida. Por favor, escolha um número da lista.";
          break;
        }

        const selectedSlot = availableSlots[slotIndex];
        console.log("Valor de selectedSlot:", selectedSlot);

        // Converta o formato "DD/MM/YYYY HH:mm" para "YYYY-MM-DDTHH:mm:ss"
        const [datePart, timePart] = selectedSlot.split(" ");
        const [day, month, year] = datePart.split("/");
        const [hour, minute] = timePart.split(":");

        const timeZone = "America/Sao_Paulo";
        const isoStartDateTime = `${year}-${month}-${day}T${hour}:${minute}:00`;
        const isoEndDateTime = `${year}-${month}-${day}T${String(
          parseInt(hour, 10) + 1
        ).padStart(2, "0")}:${minute}:00`;

        const event = {
          summary: "Consulta",
          description: "Consulta médica agendada pelo sistema.",
          start: {
            dateTime: isoStartDateTime,
            timeZone,
          },
          end: {
            dateTime: isoEndDateTime,
            timeZone,
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

      case "Marcar Consulta":
        try {
          const calendarId = "jurami.junior@gmail.com";
          const availableSlots = await getAvailableSlots(calendarId);

          if (availableSlots.length === 0) {
            responseText =
              "Não há horários disponíveis no momento. Por favor, tente novamente mais tarde.";
          } else {
            responseText = `Os horários disponíveis são: \n${availableSlots
              .map((s, i) => `${i + 1}) ${s}`)
              .join(
                "\n"
              )}\nPor favor, responda com o número do horário desejado.\nCaso queira cadastrar uma consulta manualmente, responda com 0.`;
          }
        } catch (error) {
          console.error("Erro ao enviar lista de horários:", error);
          responseText =
            "Desculpe, ocorreu um erro ao buscar os horários disponíveis. Por favor, tente novamente mais tarde.";
        }
        break;

      case "Agendamento de Consultas": {
        const date = req.body.queryResult.parameters.date;
        responseText = `Consulta agendada para ${date}. Caso precise alterar, entre em contato.`;
        break;
      }

      case "saudacoes_e_boas_vindas": {
        //const date = req.body.queryResult.parameters.date;
        responseText = `Seja bem-vinda(o) ao consultório da *Nutri Materno-Infantil Sabrina Lagos*❕

🛜Aproveite e conheça melhor o trabalho da Nutri pelo Instagram: *@nutrisabrina.lagos*
https://www.instagram.com/nutrisabrina.lagos?igsh=MWFrbnZ0ZmY1d2g5ZA==

*Dicas* para facilitar a nossa comunicação:
📵 Esse número não atende ligações;
🚫 Não ouvimos áudios;
⚠️ Respondemos por ordem de recebimento da mensagem, por isso evite enviar a mesma mensagem mais de uma vez para não voltar ao final da fila.

Me conta como podemos te ajudar❓`;
        break;
      }

      case "Cancelar Consulta":
        responseText = "Sua consulta foi cancelada com sucesso.";
        break;

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

    const fromNumber = req.body.From;
    const incomingMessage = req.body.Body || "";

    const client = await auth.getClient();
    const accessToken = await client.getAccessToken();

    const sessionId = uuid.v4();

    if (fromNumber) {
      sessionUserMap[sessionId] = fromNumber;
    }

    const dialogflowResponse = await axios.post(
      `https://dialogflow.googleapis.com/v2/projects/${DIALOGFLOW_PROJECT_ID}/agent/sessions/${sessionId}:detectIntent`,
      {
        queryInput: {
          text: {
            text: incomingMessage,
            languageCode: "pt-BR",
          },
        },
      },
      {
        headers: {
          Authorization: `Bearer ${accessToken.token}`,
        },
      }
    );

    const responseMessage =
      dialogflowResponse.data.queryResult.fulfillmentText ||
      "Desculpe, não entendi. Poderia repetir?";

    const url = `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Messages.json`;
    const data = {
      To: fromNumber,
      From: `whatsapp:${twilioFromNumber}`,
      Body: responseMessage,
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
