import "dotenv/config";
import express, { Request, Response } from "express";
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
        const slotNumber = req.body.queryResult.parameters?.number;

        if (!slotNumber) {
          responseText = "Por favor, informe um número válido para o horário.";
          break;
        }

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

        // Converte para o formato ISO
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
          start: { dateTime: isoStartDateTime, timeZone },
          end: { dateTime: isoEndDateTime, timeZone },
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

          // Obter o contexto e os dados da sessão (se houver)
          const sessionContext =
            req.body.queryResult.outputContexts.find((ctx: { name: string }) =>
              ctx.name.endsWith("/session_vars")
            ) || {};
          const sessionVars = sessionContext.parameters || {};

          // Se não houver progresso, listar horários disponíveis
          if (!sessionVars.step) {
            const availableSlots = await getAvailableSlots(calendarId);

            if (availableSlots.length === 0) {
              responseText =
                "Não há horários disponíveis no momento. Por favor, tente novamente mais tarde.";
            } else {
              sessionVars.slots = availableSlots.slice(0, 4); // Apenas 4 horários
              sessionVars.step = "choose_slot";
              responseText =
                sessionVars.slots
                  .map((s: string, i: number) => `${i + 1}) ${s}`)
                  .join("\n") +
                "\n\nPor favor, responda com o número do horário desejado.";
            }
          }
          // Capturar o número do horário escolhido
          else if (sessionVars.step === "choose_slot") {
            const slotNumber = parseInt(req.body.queryResult.queryText);

            if (
              !slotNumber ||
              slotNumber < 1 ||
              slotNumber > sessionVars.slots.length
            ) {
              responseText = "Por favor, informe um número válido da lista.";
            } else {
              sessionVars.selectedSlot = sessionVars.slots[slotNumber - 1];
              sessionVars.step = "ask_name";
              responseText = "Qual é o seu nome?";
            }
          }
          // Capturar o nome do usuário
          else if (sessionVars.step === "ask_name") {
            sessionVars.name = req.body.queryResult.queryText;
            sessionVars.step = "ask_email";
            responseText = "Qual é o seu e-mail?";
          }
          // Capturar o e-mail do usuário
          else if (sessionVars.step === "ask_email") {
            sessionVars.email = req.body.queryResult.queryText;
            sessionVars.step = "ask_phone";
            responseText = "Qual é o seu número de telefone?";
          }
          // Capturar o telefone do usuário e pedir confirmação
          else if (sessionVars.step === "ask_phone") {
            sessionVars.phone = req.body.queryResult.queryText;
            sessionVars.step = "confirm";
            responseText = `Por favor, confirme os dados:\n\nNome: ${sessionVars.name}\nE-mail: ${sessionVars.email}\nTelefone: ${sessionVars.phone}\nData da consulta: ${sessionVars.selectedSlot}\n\nResponda com "Sim" para confirmar ou "Não" para cancelar.`;
          }
          // Confirmar a marcação ou cancelar
          else if (sessionVars.step === "confirm") {
            if (req.body.queryResult.queryText.toLowerCase() === "sim") {
              const [datePart, timePart] = sessionVars.selectedSlot.split(" ");
              const [day, month, year] = datePart.split("/");
              const [hour, minute] = timePart.split(":");

              const timeZone = "America/Sao_Paulo";
              const isoStartDateTime = `${year}-${month}-${day}T${hour}:${minute}:00`;
              const isoEndDateTime = `${year}-${month}-${day}T${String(
                parseInt(hour, 10) + 1
              ).padStart(2, "0")}:${minute}:00`;

              const event = {
                summary: "Consulta",
                description: `Consulta agendada com ${sessionVars.name}.\nTelefone: ${sessionVars.phone}\nE-mail: ${sessionVars.email}`,
                start: { dateTime: isoStartDateTime, timeZone },
                end: { dateTime: isoEndDateTime, timeZone },
              };

              // Inserir evento no calendário
              await calendar.events.insert({
                calendarId,
                requestBody: event,
              });

              responseText = `Consulta marcada com sucesso para ${sessionVars.selectedSlot}. Obrigado, ${sessionVars.name}!`;
            } else {
              responseText =
                "Consulta cancelada. Se precisar, estou à disposição.";
            }
            sessionVars.step = null; // Resetar o fluxo
          }

          // Enviar o contexto atualizado ao Dialogflow
          res.json({
            fulfillmentText: responseText,
            outputContexts: [
              {
                name: `${req.body.session}/contexts/session_vars`,
                lifespanCount: 5,
                parameters: sessionVars,
              },
            ],
          });
        } catch (error) {
          console.error("Erro ao processar solicitação:", error);
          responseText =
            "Desculpe, ocorreu um erro no sistema. Por favor, tente novamente mais tarde.";
          res.json({ fulfillmentText: responseText });
        }
        break;

      case "saudacoes_e_boas_vindas":
        responseText = `Seja bem-vinda(o) ao consultório da *Nutri Materno-Infantil Sabrina Lagos*❕\n\n🛜 Aproveite e conheça melhor o trabalho da Nutri pelo Instagram: *@nutrisabrina.lagos*\nhttps://www.instagram.com/nutrisabrina.lagos\n\n*Dicas* para facilitar a nossa comunicação:\n📵 Esse número não atende ligações;\n🚫 Não ouvimos áudios;\n⚠️ Respondemos por ordem de recebimento da mensagem, por isso evite enviar a mesma mensagem mais de uma vez para não voltar ao final da fila.\n\nMe conta como podemos te ajudar❓`;
        break;

      case "introducao_alimentar":
        responseText = `Vou te explicar direitinho como funciona o acompanhamento nutricional da Dra Sabrina, ok? 😉\n\nA Dra Sabrina vai te ajudar com a introdução alimentar do seu bebê explicando como preparar os alimentos, quais alimentos devem ou não ser oferecidos nessa fase e de quais formas oferecê-los, dentre outros detalhes.\n\n🔹 *5 a 6 meses*: Orientações para iniciar a alimentação.\n🔹 *7 meses*: Introdução dos alimentos alergênicos e aproveitamento da janela imunológica.\n🔹 *9 meses*: Evolução das texturas dos alimentos.\n🔹 *12 meses*: Check-up e orientações para transição à alimentação da família.\n\nDurante 30 dias após a consulta, você pode tirar dúvidas pelo chat do app. A Dra. responde semanalmente.`;
        break;

      case "acompanhamento_gestante":
        responseText = `Deixa eu te explicar como funciona o pré natal nutricional da Dra Sabrina \n\n A Dra Sabrina vai te ajudar a conduzir a sua gestação de forma saudável, mas sem complicar a sua rotina e sem mudanças radicais na sua alimentação.\n\n O foco do acompanhamento nutricional será no ganho de peso recomendado para o trimestre, no crescimento do bebê e na redução das chances de desenvolver complicações gestacionais. \n\n Além disso, ela prescreve toda a suplementação necessária durante a gestação, de acordo com o trimestre, com as necessidade da mamãe e do bebê, e sempre levando em consideração os resultados dos exames. \n\n Antes da primeira consulta será enviado um questionário, para que a Dra possa entender melhor as suas particularidades e, durante a consulta, consiga priorizar as questões mais importantes. \n\n Na primeira consulta, que dura em torno de 1h, ela vai te ouvir para poder entender a sua rotina e se aprofundar nas suas necessidades. \n\n Será aferido o seu peso, altura, circunferências e dobras cutâneas, para concluir seu Diagnóstico Nutricional e acompanhar a sua evolução de ganho de peso durante a gestação \n\n Pelos próximos 30 dias após a consulta, você conta com a facilidade de acessar todo o material da consulta (plano alimentar, receitas e prescrições, orientações, pedidos de exame, etc) pelo aplicativo da Dra. Sabrina.  \n\n O seu acompanhamento será feito pelo chat do app. Uma vez por semana durante os 30 dias, a Dra acessa o chat responder a todas as suas dúvidas. `;
        break;

      default:
        console.log("Enviando mensagem para o ChatGPT...");
        const finalUserInput = req.body.queryResult.queryText;
        console.log("Mensagem enviada:", finalUserInput);

        try {
          responseText = await getOpenAiCompletion(finalUserInput);
          console.log("Resposta do GPT:", responseText);
        } catch (error) {
          console.error("Erro ao buscar resposta do GPT:", error);
          responseText = "Desculpe, ocorreu um erro ao processar sua mensagem.";
        }
    }

    res.json({
      fulfillmentText: responseText,
    });
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
