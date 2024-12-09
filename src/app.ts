import "dotenv/config";
import express, { Request, Response } from "express";
import bodyParser from "body-parser";
import axios from "axios";
import { Twilio } from "twilio";
import { GoogleAuth } from "google-auth-library";
import { google } from "googleapis";
import * as uuid from "uuid";
import { toZonedTime } from "date-fns-tz";

// Validação das credenciais do Google
const credentialsJson = process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON;
if (!credentialsJson) {
  throw new Error("As credenciais do Google não estão definidas.");
}
const parsedCredentials = JSON.parse(credentialsJson);

// Configuração do Twilio
const accountSid = process.env.TWILIO_ACCOUNT_SID;
const authToken = process.env.TWILIO_AUTH_TOKEN;
const twilioClient = new Twilio(accountSid, authToken);

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

async function addCalendarToServiceAccount(calendarId: string) {
  try {
    const response = await calendar.calendarList.insert({
      requestBody: {
        id: calendarId, // O ID do calendário compartilhado
      },
    });
    console.log("Calendário adicionado à conta de serviço:", response.data);
  } catch (error) {
    const err = error as Error;
    console.error("Erro ao adicionar calendários:", err.message);
  }
}

async function listCalendars() {
  try {
    const response = await calendar.calendarList.list();
    const calendars = response.data.items || [];

    if (calendars.length === 0) {
      console.log("Nenhum calendário disponível para a conta de serviço.");
    } else {
      calendars.forEach((cal) => {
        console.log(`- ${cal.summary} (ID: ${cal.id})`);
      });
    }
  } catch (error) {
    const err = error as Error;
    console.error("Erro ao listar calendários:", err.message);
  }
}

async function getAvailableSlots(
  calendarId: string,
  weeksToSearch = 2
): Promise<string[]> {
  const workingHoursStart = 9; // 9h
  const workingHoursEnd = 18; // 18h
  const timeIncrement = 60; // Intervalo em minutos
  const timeZone = "America/Sao_Paulo";

  let startDate = new Date();
  let endDate = new Date();
  endDate.setDate(startDate.getDate() + weeksToSearch * 7);

  const freeSlots: string[] = [];

  while (startDate < endDate) {
    // Apenas terça-feira (2) e quarta-feira (3)
    if (startDate.getDay() === 2 || startDate.getDay() === 3) {
      let currentTime = new Date(startDate);
      currentTime.setHours(workingHoursStart, 0, 0, 0);
      currentTime = toZonedTime(currentTime, timeZone);

      const endOfDay = new Date(startDate);
      endOfDay.setHours(workingHoursEnd, 0, 0, 0);

      while (currentTime < endOfDay) {
        const response = await calendar.events.list({
          calendarId,
          timeMin: currentTime.toISOString(),
          timeMax: new Date(
            currentTime.getTime() + timeIncrement * 60000
          ).toISOString(),
          singleEvents: true,
          orderBy: "startTime",
        });

        const events = response.data.items || [];
        const isFree = events.length === 0;

        if (isFree) {
          freeSlots.push(
            new Date(currentTime).toLocaleString("pt-BR", { timeZone })
          );
        }

        currentTime.setMinutes(currentTime.getMinutes() + timeIncrement);
      }
    }

    // Avançar para o próximo dia
    startDate.setDate(startDate.getDate() + 1);
  }

  return freeSlots;
}

// Função para lidar com Fulfillment do Dialogflow
app.post("/fulfillment", async (req: Request, res: Response) => {
  const intentName = req.body.queryResult.intent.displayName;

  try {
    let responseText = "Desculpe, não entendi sua solicitação.";

    // Processar lógica personalizada com base na intenção
    switch (intentName) {
      case "Horários Disponíveis":
        const calendarId = "jurami.junior@gmail.com"; // Substitua pelo ID do calendário da clínica, se necessário
        const availableSlots = await getAvailableSlots(calendarId);
        responseText = `Os horários disponíveis são: ${availableSlots.join(
          ", "
        )}. Qual prefere?`;
        break;

      case "Agendamento de Consultas":
        const date = req.body.queryResult.parameters.date;
        responseText = `Consulta agendada para ${date}. Caso precise alterar, entre em contato.`;
        break;

      case "Cancelar Consulta":
        responseText = "Sua consulta foi cancelada com sucesso.";
        break;

      case "Horários Disponíveis":
        responseText =
          "Os horários disponíveis são: 10:00, 13:00 e 15:30. Qual prefere?";
        break;

      default:
        responseText = `Eu recebi sua solicitação na intenção "${intentName}", mas ainda não consigo tratá-la.`;
    }

    // Retorna a resposta ao Dialogflow
    res.json({
      fulfillmentText: responseText,
    });
  } catch (error) {
    console.error("Erro no Fulfillment:", error);
    res.status(500).send("Erro ao processar a intenção.");
  }
});

// Rota para receber mensagens do Twilio e processar via Dialogflow
app.post("/webhook", async (req, res) => {
  const incomingMessage = req.body.Body;
  const fromNumber = req.body.From;

  try {
    const client = await auth.getClient();
    const accessToken = await client.getAccessToken();
    const sessionId = uuid.v4();

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

    const responseMessage = dialogflowResponse.data.queryResult.fulfillmentText;

    await twilioClient.messages.create({
      from: "whatsapp:+14155238886",
      to: fromNumber,
      body: responseMessage,
    });

    res.status(200).send("Mensagem processada com sucesso.");
  } catch (error) {
    console.error("Erro ao processar a mensagem:", error);
    res.status(500).send("Erro ao processar a mensagem.");
  }
});

// Iniciar o servidor
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Servidor rodando na porta ${PORT}`);
  // Substitua pelo ID do calendário compartilhado
  // const calendarId = "jurami.junior@gmail.com";
  //addCalendarToServiceAccount(calendarId);
  // listCalendars().catch(console.error);
});
