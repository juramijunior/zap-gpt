import "dotenv/config";
import express from "express";
import { Request, Response, RequestHandler } from "express";
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

const sessionUserMap: { [key: string]: string } = {};

// Função para dividir mensagens longas
function dividirMensagem(mensagem: string, tamanhoMax = 1600): string[] {
  const partes: string[] = [];
  for (let i = 0; i < mensagem.length; i += tamanhoMax) {
    partes.push(mensagem.substring(i, i + tamanhoMax));
  }
  return partes;
}

// Função para buscar horários disponíveis
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
        // Verificar se o horário é passado
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

// Rota do Express

// Fulfillment Handler
const fulfillmentHandler: RequestHandler = async (
  req: Request,
  res: Response
): Promise<void> => {
  const intentName = req.body.queryResult?.intent?.displayName || "";
  const sessionPath: string = req.body.session || "";
  const sessionId = sessionPath.split("/").pop() || "";
  const userQuery = req.body.queryResult?.queryText || "";
  const audioUrl = req.body.originalDetectIntentRequest?.payload?.audioUrl;

  let responseText = "Desculpe, não entendi sua solicitação.";

  try {
    let finalUserInput = userQuery;

    // Transcrição de áudio, se houver
    if (audioUrl) {
      try {
        console.log("Áudio recebido. Iniciando transcrição...");
        finalUserInput = await transcribeAudio(audioUrl);
        console.log("Transcrição concluída:", finalUserInput);
      } catch (audioError) {
        console.error("Erro ao transcrever o áudio:", audioError);
        responseText =
          "Não consegui entender o áudio enviado. Tente novamente.";
        return void res.json({ fulfillmentText: responseText });
      }
    }

    // Lógica com base na intenção
    switch (intentName) {
      case "Horários Disponíveis":
        try {
          const calendarId = "jurami.junior@gmail.com";
          const availableSlots = await getAvailableSlots(calendarId);

          responseText =
            availableSlots.length === 0
              ? "Não há horários disponíveis no momento. Por favor, tente novamente mais tarde."
              : `Os horários disponíveis são:\n${availableSlots
                  .map((s, i) => `${i + 1}) ${s}`)
                  .join(
                    "\n"
                  )}\n\nPor favor, responda com o número do horário desejado. Caso queira cadastrar uma consulta específica, responda com 0.`;

          return void res.json({ fulfillmentText: responseText });
        } catch (error) {
          console.error("Erro ao obter horários:", error);
          responseText =
            "Erro ao obter os horários disponíveis. Tente novamente.";
          return void res.json({ fulfillmentText: responseText });
        }

      case "Selecionar Horário":
        try {
          const slotNumber = parseInt(
            req.body.queryResult?.parameters?.number,
            10
          );
          const calendarId = "jurami.junior@gmail.com";
          const availableSlots = await getAvailableSlots(calendarId);

          if (
            isNaN(slotNumber) ||
            slotNumber < 1 ||
            slotNumber > availableSlots.length
          ) {
            responseText = "Por favor, informe um número válido.";
            return void res.json({ fulfillmentText: responseText });
          }

          const selectedSlot = availableSlots[slotNumber - 1];
          console.log("Horário selecionado:", selectedSlot);

          responseText = `Consulta marcada com sucesso para ${selectedSlot}.`;
          return void res.json({ fulfillmentText: responseText });
        } catch (error) {
          console.error("Erro ao selecionar horário:", error);
          responseText = "Erro ao processar o horário selecionado.";
          return void res.json({ fulfillmentText: responseText });
        }

      case "Marcar Consulta":
        try {
          const calendarId = "jurami.junior@gmail.com";

          const outputContexts = req.body.queryResult.outputContexts || [];
          let sessionContext = outputContexts.find((ctx: any) =>
            ctx.name.endsWith("/session_vars")
          ) || { parameters: {} };

          const sessionVars: SessionVars = sessionContext.parameters || {};
          sessionVars.step = sessionVars.step || "";

          console.log("Parâmetros recebidos no Webhook:", sessionVars);

          // =================== Etapa 1: Listar horários ===================
          if (!sessionVars.step) {
            const availableSlots = await getAvailableSlots(calendarId);

            if (!availableSlots || availableSlots.length === 0) {
              console.log("Sem horários disponíveis.");
              res.json({
                fulfillmentText:
                  "Não há horários disponíveis no momento. Por favor, tente novamente mais tarde.",
              });
              return;
            }

            sessionVars.slots = availableSlots.slice(0, 4);
            sessionVars.step = "choose_slot";

            const slotOptions = sessionVars.slots
              .map((slot, index) => `${index + 1}) ${slot}`)
              .join("\n");

            console.log("Enviando horários disponíveis...");
            res.json({
              fulfillmentText: `${slotOptions}\n\nPor favor, escolha o número do horário desejado.`,
              outputContexts: [
                {
                  name: `${req.body.session}/contexts/session_vars`,
                  lifespanCount: 5,
                  parameters: { ...sessionVars, step: "choose_slot" },
                },
              ],
            });
            return;
          }

          // =================== Etapa 2: Escolher horário ===================
          if (sessionVars.step === "choose_slot") {
            const userInput = req.body.queryResult.queryText.trim();
            const slotNumber = parseInt(userInput, 10);

            console.log(
              "Entrada do usuário:",
              userInput,
              "Número validado:",
              slotNumber
            );

            if (
              sessionVars.slots &&
              !isNaN(slotNumber) &&
              slotNumber > 0 &&
              slotNumber <= sessionVars.slots.length
            ) {
              sessionVars.selectedSlot = sessionVars.slots[slotNumber - 1];
              sessionVars.step = "ask_name";

              console.log("Horário selecionado:", sessionVars.selectedSlot);

              res.json({
                fulfillmentText: "Qual é o seu nome?",
                outputContexts: [
                  {
                    name: `${req.body.session}/contexts/session_vars`,
                    lifespanCount: 5,
                    parameters: { ...sessionVars, step: "ask_name" },
                  },
                ],
              });
              return;
            }

            console.log("Entrada inválida.");
            res.json({
              fulfillmentText: "Por favor, informe um número válido da lista.",
            });
            return;
          }

          // =================== Etapa 3: Capturar nome ===================
          if (sessionVars.step === "ask_name") {
            sessionVars.name = req.body.queryResult.queryText;
            sessionVars.step = "confirm";

            console.log("Nome capturado:", sessionVars.name);

            res.json({
              fulfillmentText: `Confirme o agendamento para ${sessionVars.selectedSlot}. Responda com "sim" para confirmar ou "não" para cancelar.`,
              outputContexts: [
                {
                  name: `${req.body.session}/contexts/session_vars`,
                  lifespanCount: 5,
                  parameters: { ...sessionVars, step: "confirm" },
                },
              ],
            });
            return;
          }

          // =================== Etapa 4: Confirmar agendamento ===================
          if (sessionVars.step === "confirm") {
            const confirmation = req.body.queryResult.queryText.toLowerCase();

            if (confirmation === "sim" && sessionVars.selectedSlot) {
              console.log(
                "Agendamento confirmado para:",
                sessionVars.selectedSlot
              );

              res.json({
                fulfillmentText: `Consulta marcada com sucesso para ${sessionVars.selectedSlot}. Obrigado, ${sessionVars.name}!`,
                outputContexts: [
                  {
                    name: `${req.body.session}/contexts/session_vars`,
                    lifespanCount: 0,
                  },
                ],
              });
              return;
            }

            if (confirmation === "não") {
              console.log("Agendamento cancelado.");
              res.json({
                fulfillmentText:
                  "Agendamento cancelado. Se precisar, estou à disposição para ajudar.",
                outputContexts: [
                  {
                    name: `${req.body.session}/contexts/session_vars`,
                    lifespanCount: 0,
                  },
                ],
              });
              return;
            }

            console.log("Entrada inválida na confirmação.");
            res.json({
              fulfillmentText: "Por favor, responda com 'sim' ou 'não'.",
            });
            return;
          }
        } catch (error) {
          console.error("Erro ao processar solicitação:", error);
          res.json({
            fulfillmentText:
              "Desculpe, ocorreu um erro no sistema. Por favor, tente novamente mais tarde.",
          });
        }
        break;

      case "saudacoes_e_boas_vindas":
        responseText = `Seja bem-vinda(o) ao consultório da *Nutri Materno-Infantil Sabrina Lagos*❕\n\nMe conta como posso te ajudar?`;
        return void res.json({ fulfillmentText: responseText });

      default:
        console.log("Enviando mensagem para o ChatGPT...");
        try {
          responseText = await getOpenAiCompletion(finalUserInput);
          console.log("Resposta do GPT:", responseText);
        } catch (error) {
          console.error("Erro ao buscar resposta do GPT:", error);
          responseText = "Ocorreu um erro ao processar sua mensagem.";
        }
        return void res.json({ fulfillmentText: responseText });
    }
  } catch (error) {
    console.error("Erro no Fulfillment:", error);
    if (!res.headersSent) {
      return void res
        .status(500)
        .json({ fulfillmentText: "Erro ao processar a intenção." });
    }
  }
};

// Rota do Express
app.post("/fulfillment", fulfillmentHandler);

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

    // Passo 1: Se o usuário enviou um áudio, faça a transcrição
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

    // Passo 2: Enviar mensagem (ou transcrição) para o Dialogflow
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

    // Passo 3: Dividir mensagem e enviar pelo Twilio
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

interface OutputContext {
  name: string;
  lifespanCount?: number;
  parameters?: { [key: string]: any };
}

interface SessionVars {
  step?: string;
  slots?: string[];
  selectedSlot?: string;
  name?: string;
}
