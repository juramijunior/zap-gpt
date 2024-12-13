import "dotenv/config";
import express, { Request, Response } from "express";
import bodyParser from "body-parser";
import axios from "axios";
import { Twilio } from "twilio";
import { GoogleAuth } from "google-auth-library";
import { google } from "googleapis";
import * as uuid from "uuid";
import * as dateFnsTz from "date-fns-tz";

const toZonedTime = dateFnsTz.toZonedTime;
const format = dateFnsTz.format;

// Validação das credenciais do Google
const credentialsJson = process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON;
if (!credentialsJson) {
  throw new Error("As credenciais do Google não estão definidas.");
}
const parsedCredentials = JSON.parse(credentialsJson);

// Configuração do Twilionpm install date-fns date-fns-tz
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
  const timeZone = "America/Sao_Paulo"; // Defina o fuso horário correto
  let startDate = new Date(); // Data inicial
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

    let currentDate = toZonedTime(startDate, timeZone); // Converte para o fuso horário correto

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
        currentDate = toZonedTime(currentDate, timeZone); // Atualiza o fuso horário para o próximo dia
        continue;
      }

      // Configurar horário inicial do dia
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
            return false; // Ignora eventos inválidos
          }

          return currentDate >= eventStart && currentDate < eventEnd;
        });

        if (isFree) {
          freeSlots.push(
            format(currentDate, "dd/MM/yyyy, HH:mm:ss", { timeZone })
          );
        }

        currentDate.setMinutes(currentDate.getMinutes() + timeIncrement); // Incrementa o horário
      }

      // Avançar para o próximo dia
      currentDate.setDate(currentDate.getDate() + 1);
      currentDate = toZonedTime(currentDate, timeZone); // Atualiza o fuso horário para o próximo dia
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

      case "Selecionar Horário": {
        const slotIndex =
          parseInt(req.body.queryResult.parameters.slotNumber) - 1;
        const calendarId = "jurami.junior@gmail.com";
        const availableSlots = await getAvailableSlots(calendarId);

        if (slotIndex < 0 || slotIndex >= availableSlots.length) {
          responseText =
            "A escolha não é válida. Por favor, escolha um número da lista.";
          break;
        }

        const selectedSlot = availableSlots[slotIndex];

        const event = {
          summary: "Consulta",
          description: "Consulta médica agendada pelo sistema.",
          start: {
            dateTime: new Date(selectedSlot).toISOString(),
            timeZone: "America/Sao_Paulo",
          },
          end: {
            dateTime: new Date(
              new Date(selectedSlot).getTime() + 60 * 60000
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

      case "Marcar Consulta": {
        try {
          const calendarId = "jurami.junior@gmail.com"; // ID do calendário
          const availableSlots = await getAvailableSlots(calendarId);

          if (availableSlots.length === 0) {
            responseText =
              "Não há horários disponíveis no momento. Por favor, tente novamente mais tarde.";
            res.json({ fulfillmentText: responseText });
            return;
          }

          // Construir lista de dias e horários para mensagem interativa
          const slotsAvailable = availableSlots.map((slot, index) => {
            const [day, time] = slot.split(",").map((s) => s.trim());
            return {
              id: `slot_${index + 1}`,
              title: `${day} - ${time}`,
              description: "Clique para selecionar este horário",
            };
          });

          // Estrutura da mensagem interativa
          const message = {
            to: `whatsapp:${req.body.originalDetectIntentRequest.payload.data.from}`, // Número do usuário
            from: `whatsapp:${process.env.TWILIO_PHONE_NUMBER}`, // Seu número Twilio
            interactive: {
              type: "list",
              header: {
                type: "text",
                text: "Escolha um dia e horário",
              },
              body: {
                text: "Selecione um dos horários disponíveis abaixo:",
              },
              footer: {
                text: "Clique em uma opção para confirmar o agendamento.",
              },
              action: {
                button: "Ver opções",
                sections: [
                  {
                    title: "Horários disponíveis",
                    rows: slotsAvailable,
                  },
                ],
              },
            },
          };

          // Enviar mensagem interativa usando Twilio
          const twilioClient = require("twilio")(
            process.env.TWILIO_ACCOUNT_SID,
            process.env.TWILIO_AUTH_TOKEN
          );

          await twilioClient.messages.create(message);

          // Envia resposta ao Dialogflow informando o usuário que a lista foi enviada
          res.json({
            fulfillmentText:
              "Enviei uma lista de horários disponíveis no WhatsApp. Por favor, escolha clicando em uma das opções.",
          });
        } catch (error) {
          console.error("Erro ao enviar mensagem interativa:", error);
          res.json({
            fulfillmentText:
              "Desculpe, ocorreu um erro ao buscar os horários disponíveis. Por favor, tente novamente mais tarde.",
          });
        }
        break;
      }

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
  try {
    // Verificar se as propriedades essenciais existem
    if (!req.body || !req.body.From) {
      console.error("Webhook recebido sem informações essenciais:", req.body);
      res.status(400).send("Dados insuficientes no webhook.");
      return;
    }

    const fromNumber = req.body.From;
    const incomingMessage = req.body.Body || ""; // Mensagem normal
    const interactiveResponse = req.body.Interactive || {}; // Mensagem interativa, se existir

    // Autenticação com o Google
    const client = await auth.getClient();
    const accessToken = await client.getAccessToken();
    const sessionId = uuid.v4();

    // 1. Processar Resposta Interativa
    if (interactiveResponse.list_reply) {
      const selectedOptionId = interactiveResponse.list_reply.id;

      if (selectedOptionId.startsWith("slot_")) {
        const slotIndex = parseInt(selectedOptionId.split("_")[1]) - 1;

        // Obter slots disponíveis
        const calendarId = "jurami.junior@gmail.com";
        const availableSlots = await getAvailableSlots(calendarId);

        if (!availableSlots[slotIndex]) {
          console.error("Slot selecionado não encontrado:", selectedOptionId);
          await twilioClient.messages.create({
            from: "whatsapp:+14155238886",
            to: fromNumber,
            body: "Desculpe, o horário selecionado não está disponível. Por favor, tente novamente.",
          });
          res.status(200).send("Slot inválido processado.");
          return;
        }

        const [day, time] = availableSlots[slotIndex]
          .split(",")
          .map((s) => s.trim());
        const selectedDateTime = new Date(`${day}T${time}`);

        // Criar evento no Google Calendar
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

        await calendar.events.insert({
          calendarId,
          requestBody: event,
        });

        await twilioClient.messages.create({
          from: "whatsapp:+14155238886",
          to: fromNumber,
          body: `Consulta marcada com sucesso para ${day} às ${time}.`,
        });

        res.status(200).send("Consulta marcada com sucesso.");
        return;
      }
    }

    // 2. Processar Mensagem Normal
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

    if (!res.headersSent) {
      res.status(500).send("Erro ao processar a mensagem.");
    }
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
