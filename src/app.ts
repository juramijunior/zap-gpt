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

const credentialsJson = process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON;
if (!credentialsJson) {
  throw new Error("As credenciais do Google não estão definidas.");
}
const parsedCredentials = JSON.parse(credentialsJson);

const accountSid = process.env.TWILIO_ACCOUNT_SID;
const authToken = process.env.TWILIO_AUTH_TOKEN;
const twilioClient = new Twilio(accountSid, authToken);
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

// Armazenamento em memória: { [sessionId: string]: string (fromNumber) }
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
        // Terça-feira: das 14h às 19h
        startHour = 14;
        endHour = 19;
      } else if (dayOfWeek === 3) {
        // Quarta-feira: das 8h às 13h
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

  // Extrair sessionId do campo session do Dialogflow
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
              .map((s, i) => `${i + 1}. ${s}`)
              .join("\n")}\nQual prefere? Informe o número da opção.`;
          }
        } catch (error) {
          console.error("Erro ao obter horários:", error);
          responseText =
            "Desculpe, ocorreu um erro ao obter os horários disponíveis. Tente novamente mais tarde.";
        }
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

      case "Marcar Consulta": {
        // Aqui vamos usar o número armazenado no sessionUserMap
        const fromNumber = sessionUserMap[sessionId];
        if (!fromNumber || !twilioFromNumber) {
          console.error("Número de usuário ou Twilio não definido.");
          responseText =
            "Não foi possível enviar a lista de horários disponíveis. Por favor, tente novamente mais tarde.";
          break;
        }
        try {
          const calendarId = "jurami.junior@gmail.com";
          const availableSlots = await getAvailableSlots(calendarId);

          if (availableSlots.length === 0) {
            responseText =
              "Não há horários disponíveis no momento. Por favor, tente novamente mais tarde.";
            break;
          }

          const slotsAvailable = availableSlots.map((slot, index) => {
            const [day, time] = slot.split(" ");
            return {
              id: `slot_${index + 1}`,
              title: `${day} - ${time}`,
              description: "Clique para selecionar este horário",
            };
          });

          const message = {
            to: `whatsapp:${fromNumber}`,
            from: `whatsapp:${twilioFromNumber}`,
            type: "interactive",
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

          await twilioClient.messages.create(message);

          responseText =
            "Enviei uma lista de horários disponíveis no WhatsApp. Por favor, escolha clicando em uma das opções.";
        } catch (error) {
          console.error("Erro ao enviar mensagem interativa:", error);
          responseText =
            "Desculpe, ocorreu um erro ao buscar os horários disponíveis. Por favor, tente novamente mais tarde.";
        }
        break;
      }

      case "Agendamento de Consultas": {
        const date = req.body.queryResult.parameters.date;
        responseText = `Consulta agendada para ${date}. Caso precise alterar, entre em contato.`;
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
    if (!req.body || (!req.body.From && !req.body.Interactive)) {
      console.error("Requisição inválida recebida:", req.body);
      if (!res.headersSent) {
        res.status(400).send("Requisição inválida.");
      }
      return;
    }

    const fromNumber = req.body.From;
    const incomingMessage = req.body.Body || "";
    const interactiveResponse = req.body.Interactive || {};

    const client = await auth.getClient();
    const accessToken = await client.getAccessToken();

    // Gerar um sessionId único para cada mensagem do usuário
    const sessionId = uuid.v4();

    // Armazena o número do usuário na sessão
    if (fromNumber) {
      sessionUserMap[sessionId] = fromNumber;
    }

    // Processar resposta interativa
    if (interactiveResponse.list_reply) {
      const selectedOptionId = interactiveResponse.list_reply.id;

      if (selectedOptionId.startsWith("slot_")) {
        const slotIndex = parseInt(selectedOptionId.split("_")[1]) - 1;

        const calendarId = "jurami.junior@gmail.com";
        const availableSlots = await getAvailableSlots(calendarId);

        if (!availableSlots[slotIndex]) {
          console.error("Slot selecionado não encontrado:", selectedOptionId);

          await twilioClient.messages.create({
            from: `whatsapp:${twilioFromNumber}`,
            to: fromNumber,
            body: "Desculpe, o horário selecionado não está disponível. Por favor, tente novamente.",
          });

          if (!res.headersSent) {
            res.status(200).send("Slot inválido processado.");
          }
          return;
        }

        const [day, time] = availableSlots[slotIndex].split(" ");
        const selectedDateTime = new Date(`${day}T${time}`);

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
          from: `whatsapp:${twilioFromNumber}`,
          to: fromNumber,
          body: `Consulta marcada com sucesso para ${day} às ${time}.`,
        });

        if (!res.headersSent) {
          res.status(200).send("Consulta marcada com sucesso.");
        }
        return;
      }
    }

    // Caso seja uma mensagem normal, enviar ao Dialogflow
    if (incomingMessage) {
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

      await twilioClient.messages.create({
        from: `whatsapp:${twilioFromNumber}`,
        to: fromNumber,
        body: responseMessage,
      });

      if (!res.headersSent) {
        res.status(200).send("Mensagem processada com sucesso.");
      }
      return;
    }

    // Caso nada seja processado
    if (!res.headersSent) {
      res.status(400).send("Requisição não pôde ser processada.");
    }
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
});
