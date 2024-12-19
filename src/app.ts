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

app.post("/fulfillment", async (req: Request, res: Response) => {
  const intentName = req.body.queryResult.intent.displayName;
  const sessionPath: string = req.body.session || "";
  const sessionId = sessionPath.split("/").pop() || "";
  const userQuery = req.body.queryResult.queryText;
  const audioUrl = req.body.originalDetectIntentRequest?.payload?.audioUrl;

  let responseText = "Desculpe, não entendi sua solicitação.";

  try {
    let finalUserInput = userQuery;

    // Se houver um áudio, transcreve antes de processar
    if (audioUrl) {
      try {
        console.log("Áudio recebido. Iniciando transcrição...");
        finalUserInput = await transcribeAudio(audioUrl);
        console.log("Transcrição concluída:", finalUserInput);
      } catch (audioError) {
        console.error("Erro ao transcrever o áudio:", audioError);
        responseText =
          "Não consegui entender o áudio enviado. Tente novamente.";
      }
    }
    switch (intentName) {
      case "Horários Disponíveis":
        try {
          const calendarId = "jurami.junior@gmail.com";
          const availableSlots = await getAvailableSlots(calendarId);

          if (availableSlots.length === 0) {
            responseText =
              "Não há horários disponíveis no momento. Por favor, tente novamente mais tarde.";
          } else {
            responseText = `Os horários disponíveis são:\n${availableSlots
              .map((s, i) => `${i + 1}) ${s}`)
              .join(
                "\n"
              )}\n\nPor favor, responda com o número do horário desejado. Caso queira cadastrar uma consulta específica, responda com 0.`;
          }
        } catch (error) {
          console.error("Erro ao obter horários:", error);
          responseText =
            "Desculpe, ocorreu um erro ao obter os horários disponíveis. Tente novamente mais tarde.";
        }
        break;

      case "Selecionar Horário": {
        console.log("Iniciando a intenção Selecionar Horário...");

        // Declara o tipo dos contextos
        const context = req.body.queryResult.outputContexts.find(
          (c: { name: string; parameters: any }) =>
            c.name.includes("marcar_consulta_context")
        );

        const slotNumber =
          req.body.queryResult.parameters?.number ||
          context?.parameters?.number;

        console.log("Número do horário selecionado:", slotNumber);

        if (!slotNumber) {
          res.json({
            fulfillmentText: "Por favor, informe o número do horário desejado.",
          });
          break;
        }

        res.json({
          fulfillmentText: `Número ${slotNumber} registrado com sucesso. Por favor, informe o seu nome.`,
        });
        break;
      }

      case "Marcar Consulta": {
        console.log("Iniciando a intenção Marcar Consulta...");

        // Captura o número do horário (se fornecido)
        const slotNumber = req.body.queryResult.parameters?.number || null;

        const calendarId = "jurami.junior@gmail.com";
        const availableSlots = await getAvailableSlots(calendarId);

        if (availableSlots.length === 0) {
          res.json({
            fulfillmentText:
              "Não há horários disponíveis no momento. Por favor, tente novamente mais tarde.",
          });
          break;
        }

        if (!slotNumber) {
          // Exibe os horários disponíveis
          let responseText = `Os horários disponíveis são:\n${availableSlots
            .map((s, i) => `${i + 1}) ${s}`)
            .join(
              "\n"
            )}\n\nPor favor, responda com o número do horário desejado.`;
          console.log("Mensagem de horários disponíveis:", responseText);

          // Envia a lista de horários e define o contexto de saída
          res.json({
            fulfillmentText: responseText,
            outputContexts: [
              {
                name: `${req.body.session}/contexts/marcar_consulta_context`,
                lifespanCount: 5,
                parameters: { availableSlots }, // Armazena os horários disponíveis
              },
            ],
          });
          break;
        }

        console.log("Número do horário já recebido:", slotNumber);
        // Continue com o fluxo...
        break;
      }

      case "saudacoes_e_boas_vindas":
        responseText = `Seja bem-vinda(o) ao consultório da *Nutri Materno-Infantil Sabrina Lagos*❕\n\n🛜 Aproveite e conheça melhor o trabalho da Nutri pelo Instagram: *@nutrisabrina.lagos*\nhttps://www.instagram.com/nutrisabrina.lagos\n\n*Dicas* para facilitar a nossa comunicação:\n📵 Esse número não atende ligações;\n🚫 Não ouvimos áudios;\n⚠️ Respondemos por ordem de recebimento da mensagem, por isso evite enviar a mesma mensagem mais de uma vez para não voltar ao final da fila.\n\nMe conta como podemos te ajudar❓`;
        break;

      case "introducao_alimentar":
        responseText = `Vou te explicar direitinho como funciona o acompanhamento nutricional da Dra Sabrina, ok? 😉\n\nA Dra Sabrina vai te ajudar com a introdução alimentar do seu bebê explicando como preparar os alimentos, quais alimentos devem ou não ser oferecidos nessa fase e de quais formas oferecê-los, dentre outros detalhes.\n\n🔹 *5 a 6 meses*: Orientações para iniciar a alimentação.\n🔹 *7 meses*: Introdução dos alimentos alergênicos e aproveitamento da janela imunológica.\n🔹 *9 meses*: Evolução das texturas dos alimentos.\n🔹 *12 meses*: Check-up e orientações para transição à alimentação da família.\n\nDurante 30 dias após a consulta, você pode tirar dúvidas pelo chat do app. A Dra. responde semanalmente.`;
        break;

      default:
        console.log("Enviando mensagem para o ChatGPT...");
        console.log("Mensagem enviada:", finalUserInput);

        responseText = await getOpenAiCompletion(finalUserInput);
        console.log("Resposta do GPT:", responseText);
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
