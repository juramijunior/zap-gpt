import "dotenv/config";
import express, { Request, Response } from "express";
import bodyParser from "body-parser";
import axios from "axios";
import { Twilio } from "twilio";
import { GoogleAuth } from "google-auth-library";
import { google } from "googleapis";
import * as uuid from "uuid";

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
  const timeIncrement = 60; // Intervalo em minutos
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

    const currentDate = new Date(startDate);

    while (currentDate < endDate) {
      const dayOfWeek = currentDate.getDay(); // 0 (Domingo) a 6 (Sábado)

      // Configurar horários específicos para terça e quarta-feira
      let startHour = 0;
      let endHour = 0;

      if (dayOfWeek === 2) {
        // Terça-feira: das 14h às 19h
        startHour = 14;
        endHour = 19;
      } else if (dayOfWeek === 3) {
        // Quarta-feira: das 8h às 13h
        startHour = 8;
        endHour = 13;
      } else {
        // Ignorar outros dias
        currentDate.setDate(currentDate.getDate() + 1);
        continue;
      }

      // Configurar horário inicial do dia
      currentDate.setHours(startHour, 0, 0, 0);

      while (currentDate.getHours() < endHour) {
        const isFree = !events.some((event) => {
          const eventStart = event.start?.dateTime
            ? new Date(event.start.dateTime)
            : event.start?.date
            ? new Date(event.start.date)
            : null;
          const eventEnd = event.end?.dateTime
            ? new Date(event.end.dateTime)
            : event.end?.date
            ? new Date(event.end.date)
            : null;

          if (!eventStart || !eventEnd) {
            return false; // Ignora eventos inválidos
          }

          return currentDate >= eventStart && currentDate < eventEnd;
        });

        if (isFree) {
          freeSlots.push(
            new Date(currentDate).toLocaleString("pt-BR", {
              timeZone: "America/Sao_Paulo",
            })
          );
        }

        currentDate.setMinutes(currentDate.getMinutes() + timeIncrement); // Incrementa o horário
      }

      // Avançar para o próximo dia
      currentDate.setDate(currentDate.getDate() + 1);
    }

    return freeSlots;
  } catch (error) {
    console.error("Erro ao buscar horários disponíveis:", error);
    throw new Error("Erro ao buscar horários disponíveis");
  }
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
