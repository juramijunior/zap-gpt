import "dotenv/config";
import express from "express";
import { Request, Response } from "express";
import bodyParser from "body-parser";
import axios from "axios";
import { GoogleAuth } from "google-auth-library";
import { google } from "googleapis";
import * as dateFnsTz from "date-fns-tz";
import qs from "qs";

import { v4 as uuidv4 } from "uuid";
import { transcribeAudio, getOpenAiCompletion } from "./services/openai";

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

// Armazena estados da conversa (ex.: AWAITING_EMAIL, AWAITING_NAME...)
const conversationStateMap: { [key: string]: any } = {};

/**
 * Divide uma string em partes menores para enviar via Twilio (limite de caracteres)
 */
function dividirMensagem(mensagem: string, tamanhoMax = 1600): string[] {
  const partes: string[] = [];
  for (let i = 0; i < mensagem.length; i += tamanhoMax) {
    partes.push(mensagem.substring(i, i + tamanhoMax));
  }
  return partes;
}

/**
 * Busca horários disponíveis no Google Calendar
 */
async function getAvailableSlots(
  calendarId: string,
  weeksToSearch = 2
): Promise<string[]> {
  const timeIncrement = 60; // em minutos
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

      // Exemplo: Terça das 14h às 19h, Quarta das 8h às 13h
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

/**
 * Retorna as consultas marcadas para um determinado e-mail
 */
async function getBookedAppointments(
  calendarId: string,
  clientEmail: string
): Promise<{ id: string; description: string; date: string }[]> {
  const timeZone = "America/Sao_Paulo"; // Define o fuso horário
  const response = await calendar.events.list({
    calendarId,
    timeMin: new Date().toISOString(), // Inclui apenas eventos futuros
    singleEvents: true,
    orderBy: "startTime",
  });

  const events = response.data.items || [];

  // Filtro unificado: considera apenas eventos que mencionam "consulta"
  return events
    .filter(
      (event) =>
        (event.summary?.toLowerCase().includes("consulta") || // Verifica se "consulta" está no campo summary
          event.description?.toLowerCase().includes("consulta")) && // Ou no campo description
        (event.description?.includes(clientEmail) || // Verifica se o e-mail está na descrição
          event.attendees?.some((attendee) => attendee.email === clientEmail)) // Ou na lista de participantes
    )
    .map((event) => {
      // Ajuste de horário para o fuso correto
      const eventStart = event.start?.dateTime
        ? toZonedTime(new Date(event.start.dateTime), timeZone) // Ajusta o horário para o fuso
        : null;

      return {
        id: event.id || "",
        description: event.summary || "Consulta sem descrição",
        date: eventStart
          ? format(eventStart, "dd/MM/yyyy HH:mm", { timeZone }) // Formata a data/hora ajustada
          : "Data não disponível",
      };
    });
}

/**
 * Deleta um agendamento do calendário
 */
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
    console.error("Erro ao remover consulta:", error);
    throw new Error("Erro ao remover consulta.");
  }
}

/**
 * Cria um evento no Google Calendar
 */
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
    summary: `Consulta com ${clientName}`,
    description: `Detalhes:\nNome: ${clientName}\nE-mail: ${clientEmail}\nTelefone: ${clientPhone}\nData/Horário: ${chosenSlot}`,
    start: { dateTime: isoStartDateTime, timeZone },
    end: { dateTime: isoEndDateTime, timeZone },
  };

  try {
    await calendar.events.insert({
      calendarId,
      requestBody: event,
    });
  } catch (err) {
    console.error("Erro ao criar evento no Google Calendar:", err);
    throw err;
  }
}

/**
 * Endpoint do Fulfillment (Dialogflow -> webhook)
 */
app.post("/fulfillment", async (req: Request, res: Response): Promise<void> => {
  console.log("=== Fulfillment recebido do Dialogflow ===");
  const intentName = req.body.queryResult.intent.displayName;
  console.log("Intenção disparada:", intentName);
  const sessionPath: string = req.body.session || "";
  const sessionId = sessionPath.split("/").pop() || "";
  const userQuery = req.body.queryResult.queryText;
  console.log("Texto do usuário:", userQuery);

  // Todos os contexts ativos
  const outputContexts = req.body.queryResult.outputContexts || [];

  // Contexto de Marcar Consulta
  const marcarConsultaContext = outputContexts.find((ctx: any) =>
    ctx.name.endsWith("marcar_consulta_flow")
  );
  // Lemos variáveis do fluxo "Marcar Consulta"
  let state = marcarConsultaContext?.parameters?.state || "INITIAL";
  let chosenSlot = marcarConsultaContext?.parameters?.chosenSlot || "";
  let clientName = marcarConsultaContext?.parameters?.clientName || "";
  let clientEmail = marcarConsultaContext?.parameters?.clientEmail || "";
  let clientPhone = marcarConsultaContext?.parameters?.clientPhone || "";
  let availableSlots = marcarConsultaContext?.parameters?.availableSlots || [];
  let currentIndex = marcarConsultaContext?.parameters?.currentIndex || 0;

  console.log("Estado atual:", state);

  let responseText = "Desculpe, não entendi sua solicitação.";

  try {
    switch (intentName) {
      // =================================
      // FLUXO MARCAR CONSULTA (INTENT PRINCIPAL)
      // =================================
      case "Marcar Consulta (Início)": {
        // Ex.: Quando o usuário diz “Quero marcar uma consulta”
        // Vamos buscar horários e iniciar o fluxo.
        const calendarId = "jurami.junior@gmail.com";

        console.log("Usuário iniciou o fluxo de Marcar Consulta (Início).");
        if (state === "INITIAL") {
          const fetchedSlots = await getAvailableSlots(calendarId);

          if (fetchedSlots.length === 0) {
            responseText =
              "Não há horários disponíveis no momento. Por favor, tente novamente mais tarde.";
            state = "FINISHED";
          } else {
            availableSlots = fetchedSlots.slice(0, 4);
            currentIndex = 4;
            responseText = `Os horários disponíveis são:\n${availableSlots
              .map((s: string, i: number) => `${i + 1} - ${s}`)
              .join(
                "\n"
              )}\n\nPor favor, responda com o número do horário desejado. Caso queira consultar mais horários, responda com 0.`;
            state = "AWAITING_SLOT_SELECTION";
          }
        }
        break;
      }

      // Sub-intent da mesma “Marcar Consulta” (fluxo) para continuar a seleção
      case "Marcar Consulta": {
        // Se esse case for disparado sem "Início", significa que já está no fluxo,
        // pois definimos "Marcar Consulta" com input context = marcar_consulta_flow,
        // ou algo assim (depende de como você configurou no Dialogflow).
        if (state === "AWAITING_SLOT_SELECTION") {
          const userNumber = parseInt(userQuery, 10);

          if (!isNaN(userNumber) && userNumber >= 0 && userNumber <= 4) {
            if (userNumber === 0) {
              console.log("Usuário pediu mais horários.");
              const calendarId = "jurami.junior@gmail.com";
              const fetchedSlots = await getAvailableSlots(calendarId);
              const nextSlots = fetchedSlots.slice(
                currentIndex,
                currentIndex + 4
              );

              if (nextSlots.length === 0) {
                responseText = "Não há mais horários disponíveis.";
              } else {
                availableSlots = nextSlots;
                currentIndex += 4;
                responseText = `Os próximos horários disponíveis são:\n${availableSlots
                  .map((s: string, i: number) => `${i + 1} - ${s}`)
                  .join(
                    "\n"
                  )}\n\nPor favor, responda com o número do horário desejado ou 0 para consultar mais horários.`;
              }
            } else {
              const slotIndex = userNumber - 1;
              if (slotIndex >= 0 && slotIndex < availableSlots.length) {
                chosenSlot = availableSlots[slotIndex];
                console.log("Horário escolhido:", chosenSlot);
                responseText =
                  "Ótimo! Agora, por favor, informe o seu nome completo.";
                state = "AWAITING_NAME";
              } else {
                responseText =
                  "Opção inválida. Por favor, escolha um número válido.";
              }
            }
          } else {
            responseText =
              "Por favor, responda com um número de 1 a 4 ou 0 para mais horários.";
          }
        } else if (state === "AWAITING_NAME") {
          // Se disparou aqui, é porque (no Dialogflow) "Marcar Consulta" também está pegando o nome
          const isName = /^[a-zA-ZÀ-ÿ\s']+$/.test(userQuery.trim());
          if (!isName) {
            responseText =
              "Por favor, informe um nome válido. Exemplo: 'Meu nome é João Silva'.";
          } else {
            // Remove "meu nome é" se houver
            clientName = userQuery.replace(/meu nome é/i, "").trim();
            responseText = `Obrigada, ${clientName}. Agora, informe o seu e-mail.`;
            state = "AWAITING_EMAIL";
          }
        } else if (state === "AWAITING_PHONE") {
          // Se disparou aqui, é porque (no Dialogflow) "Marcar Consulta" também está pegando o telefone
          const phonePattern = /meu telefone é\s*(\d{10,15})/i;
          const phoneMatch = userQuery.match(phonePattern);

          if (!phoneMatch || !phoneMatch[1]) {
            responseText =
              "Por favor, informe um número de telefone válido. Exemplo: 'Meu telefone é 61999458613'.";
          } else {
            clientPhone = phoneMatch[1].trim();
            responseText = `Por favor, confirme os dados:\nNome: ${clientName}\nE-mail: ${clientEmail}\nTelefone: ${clientPhone}\nData/Horário: ${chosenSlot}\n\nConfirma? (sim/não)`;
            state = "AWAITING_CONFIRMATION";
          }
        } else if (state === "AWAITING_CONFIRMATION") {
          // Confirma ou não a marcação
          if (userQuery.toLowerCase() === "sim") {
            console.log("Usuário confirmou. Criando evento...");
            const calendarId = "jurami.junior@gmail.com";
            await createEvent(
              calendarId,
              chosenSlot,
              clientName,
              clientEmail,
              clientPhone
            );
            responseText = "Sua consulta foi marcada com sucesso!";
            state = "FINISHED";
          } else if (userQuery.toLowerCase() === "não") {
            responseText =
              "Consulta cancelada. Caso deseje marcar novamente, diga 'Quero marcar uma consulta'.";
            state = "FINISHED";
          } else {
            responseText =
              "Por favor, responda apenas com 'Sim' para confirmar ou 'Não' para cancelar.";
          }
        }
        break;
      }

      // =================================
      // NOVA INTENT: "Marcar Consulta (Aguardando E-mail)"
      // =================================
      case "Marcar Consulta (Aguardando E-mail)": {
        // Aqui você coloca a lógica do AWAITING_EMAIL separada
        // (Input Context = marcar_consulta_flow, Output Context = marcar_consulta_flow)
        if (state === "AWAITING_EMAIL") {
          const emailPattern = /([\w.-]+@[\w.-]+\.[a-zA-Z]{2,})/i;
          const emailMatch = userQuery.match(emailPattern);

          if (!emailMatch || !emailMatch[1]) {
            responseText =
              "Por favor, informe um e-mail válido. Exemplo: 'Meu e-mail é exemplo@dominio.com'.";
          } else {
            clientEmail = emailMatch[1].trim();
            responseText = "Agora, informe seu número de telefone, por favor.";
            state = "AWAITING_PHONE";
          }
        }
        break;
      }

      // =================================
      // FLUXO CONSULTAR CONSULTAS MARCADAS
      // =================================
      case "Consultar Consultas Marcadas (Início)": {
        // Inicia o fluxo de consultar, pedindo o e-mail
        responseText =
          "Certo! Para consultar suas consultas marcadas, por favor informe o seu e-mail.";
        break;
      }

      case "Consultar Consultas Marcadas (Aguardando E-mail)": {
        const emailPattern = /([\w.-]+@[\w.-]+\.[a-zA-Z]{2,})/i;
        const emailMatch = userQuery.match(emailPattern);

        if (!emailMatch || !emailMatch[1]) {
          responseText =
            "Por favor, informe um e-mail válido no formato correto. Exemplo: exemplo@dominio.com.";
        } else {
          const emailBuscado = emailMatch[1].trim();
          const consultasMarcadas = await getBookedAppointments(
            "jurami.junior@gmail.com",
            emailBuscado
          );

          if (consultasMarcadas.length === 0) {
            responseText = `Não encontramos consultas marcadas para o e-mail ${emailBuscado}.`;
          } else {
            responseText = `Consultas marcadas para o e-mail ${emailBuscado}:\n${consultasMarcadas
              .map(
                (consulta, index) =>
                  `${index + 1} - ${consulta.description} (${consulta.date})`
              )
              .join("\n")}`;
          }
        }
        break;
      }

      // =================================
      // DESMARCAR
      // =================================
      case "Desmarcar Consultas": {
        console.log("Intenção 'Desmarcar Consulta' acionada.");

        // Busca o e-mail no contexto
        const consultarContext = outputContexts.find((ctx: any) =>
          ctx.name.endsWith("consultar_consulta_marcada_flow")
        );
        const clientEmail = consultarContext?.parameters?.clientEmail || "";

        // Se o e-mail não está disponível, solicite
        if (!clientEmail) {
          responseText =
            "Por favor, informe o seu e-mail para que eu possa verificar suas consultas marcadas.";
          state = "AWAITING_EMAIL_FOR_CANCEL";
          break;
        }

        // Lógica de cancelamento continua se o e-mail estiver disponível
        const consultasMarcadas = await getBookedAppointments(
          "jurami.junior@gmail.com",
          clientEmail
        );

        if (consultasMarcadas.length === 0) {
          responseText = "Você não possui consultas marcadas no momento.";
          state = "FINISHED";
        } else {
          responseText = `Selecione a consulta que deseja desmarcar:\n${consultasMarcadas
            .map(
              (consulta, index) =>
                `${index + 1} - ${consulta.description} (${consulta.date})`
            )
            .join("\n")}\n\nResponda com o número correspondente.`;
          state = "AWAITING_CANCEL_SELECTION";
        }
        break;
      }

      case "Desmarcar Consultas (Aguardando E-mail)": {
        console.log(
          "Intenção 'Desmarcar Consultas (Aguardando E-mail)' acionada."
        );

        // Extrai o e-mail do texto do usuário
        const emailPattern = /([\w.-]+@[\w.-]+\.[a-zA-Z]{2,})/i;
        const emailMatch = userQuery.match(emailPattern);

        if (!emailMatch || !emailMatch[1]) {
          responseText =
            "O e-mail fornecido não parece ser válido. Por favor, envie novamente no formato correto (exemplo@dominio.com).";
          break;
        }

        const clientEmail = emailMatch[1].trim();

        // Salvar o e-mail no contexto
        const consultasMarcadas = await getBookedAppointments(
          "jurami.junior@gmail.com",
          clientEmail
        );

        if (consultasMarcadas.length === 0) {
          responseText = `Não encontramos consultas marcadas para o e-mail ${clientEmail}.`;
          state = "FINISHED";
        } else {
          responseText = `Selecione a consulta que deseja desmarcar:\n${consultasMarcadas
            .map(
              (consulta, index) =>
                `${index + 1} - ${consulta.description} (${consulta.date})`
            )
            .join("\n")}\n\nResponda com o número correspondente.`;
          state = "AWAITING_CANCEL_SELECTION";
        }
        break;
      }

      case "Desmarcar Consultas - Seleção": {
        if (state === "AWAITING_CANCEL_SELECTION") {
          const userNumber = parseInt(userQuery, 10); // Captura o número do usuário
          const consultasMarcadas = await getBookedAppointments(
            "jurami.junior@gmail.com",
            clientEmail
          );

          if (
            !isNaN(userNumber) &&
            userNumber >= 1 &&
            userNumber <= consultasMarcadas.length
          ) {
            // Seleciona a consulta correspondente
            const consultaSelecionada = consultasMarcadas[userNumber - 1];

            // Remove a consulta do calendário
            await deleteAppointment(
              "jurami.junior@gmail.com",
              consultaSelecionada.id
            );

            // Confirmação ao usuário
            responseText = `A consulta "${consultaSelecionada.description}" marcada para ${consultaSelecionada.date} foi desmarcada com sucesso.`;
            state = "FINISHED";
          } else {
            responseText = `Número inválido. Por favor, escolha um número de 1 a ${consultasMarcadas.length}.`;
          }
        } else {
          responseText = "Desculpe, não entendi sua solicitação.";
        }

        break;
      }

      // =================================
      // OUTRAS INTENTS ESPECÍFICAS
      // =================================
      case "saudacoes_e_boas_vindas":
        responseText = `Seja bem-vinda(o) ao consultório da *Nutri Materno-Infantil Sabrina Lagos*❕\n\n🛜 Aproveite e conheça melhor o trabalho da Nutri pelo Instagram: *@nutrisabrina.lagos*\nhttps://www.instagram.com/nutrisabrina.lagos\n\n*Dicas* para facilitar a nossa comunicação:\n📵 Esse número não atende ligações;\n🚫 Não ouvimos áudios;\n⚠️ Respondemos por ordem de recebimento da mensagem, por isso evite enviar a mesma mensagem mais de uma vez para não voltar ao final da fila.\n\nMe conta como podemos te ajudar❓`;
        break;

      case "introducao_alimentar":
        responseText = `Vou te explicar direitinho como funciona o acompanhamento nutricional da Dra Sabrina, ok? 😉\n\nA Dra Sabrina vai te ajudar com a introdução alimentar do seu bebê explicando como preparar os alimentos, quais alimentos devem ou não ser oferecidos nessa fase e de quais formas oferecê-los, dentre outros detalhes.\n\n🔹 *5 a 6 meses*: Orientações para iniciar a alimentação.\n🔹 *7 meses*: Introdução dos alimentos alergênicos e aproveitamento da janela imunológica.\n🔹 *9 meses*: Evolução das texturas dos alimentos.\n🔹 *12 meses*: Check-up e orientações para transição à alimentação da família.\n\nDurante 30 dias após a consulta, você pode tirar dúvidas pelo chat do app. A Dra. responde semanalmente.`;
        break;

      case "acompanhamento_gestante":
        responseText = `Deixa eu te explicar como funciona o pré natal nutricional da Dra Sabrina \n\n A Dra Sabrina vai te ajudar a conduzir a sua gestação de forma saudável, mas sem complicar a sua rotina e sem mudanças radicais na sua alimentação.\n\n O foco do acompanhamento nutricional será no ganho de peso recomendado para o trimestre, no crescimento do bebê e na redução das chances de desenvolver complicações gestacionais. \n\n Além disso, ela prescreve toda a suplementação necessária durante a gestação, de acordo com o trimestre, com as necessidade da mamãe e do bebê, e sempre levando em consideração os resultados dos exames. \n\n Antes da primeira consulta será enviado um questionário, para que a Dra possa entender melhor as suas particularidades e, durante a consulta, consiga priorizar as questões mais importantes. \n\n Na primeira consulta, que dura em torno de 1h, ela vai te ouvir para poder entender a sua rotina e se aprofundar nas suas necessidades. \n\n Será aferido o seu peso, altura, circunferências e dobras cutâneas, para concluir seu Diagnóstico Nutricional e acompanhar a sua evolução de ganho de peso durante a gestação \n\n Pelos próximos 30 dias após a consulta, você conta com a facilidade de acessar todo o material da consulta (plano alimentar, receitas e prescrições, orientações, pedidos de exame, etc) pelo aplicativo da Dra. Sabrina.  \n\n O seu acompanhamento será feito pelo chat do app. Uma vez por semana durante os 30 dias, a Dra acessa o chat responder a todas as suas dúvidas.`;
        break;

      // =================================
      // SE NENHUM CASE BATER -> ChatGPT
      // =================================
      default: {
        console.log(
          "Intenção não mapeada, enviando mensagem para o ChatGPT..."
        );
        try {
          const finalUserInput = userQuery.trim();
          console.log("Mensagem enviada ao GPT:", finalUserInput);

          const gptResponse = await getOpenAiCompletion(finalUserInput);
          console.log("Resposta do GPT:", gptResponse);

          // Reinicia
          state = "INITIAL";
          chosenSlot = "";
          clientName = "";
          clientEmail = "";
          clientPhone = "";
          availableSlots = [];
          currentIndex = 0;

          const responseJson = {
            fulfillmentText: gptResponse,
            outputContexts: [],
          };

          if (req.body.originalDetectIntentRequest?.payload?.data?.From) {
            const fromNumber =
              req.body.originalDetectIntentRequest.payload.data.From;
            if (conversationStateMap[fromNumber]) {
              conversationStateMap[fromNumber].state = "INITIAL";
            }
          }

          console.log("Estado e contexto reiniciados.");
          res.json(responseJson);
          return;
        } catch (error) {
          console.error("Erro ao processar resposta do GPT:", error);
          res.status(500).send("Erro ao processar a mensagem.");
          return;
        }
      }
    }

    // ========================
    // Se chegou aqui, foi alguma das Intents do switch (menos o default que deu return).
    // Monta a resposta com o context "marcar_consulta_flow" se for esse o fluxo, etc.
    // ========================
    const responseJson: any = {
      fulfillmentText: responseText,
      outputContexts: [],
    };

    // Adiciona o contexto de "marcar_consulta_flow" se for relacionado
    if (intentName.startsWith("Marcar Consulta")) {
      responseJson.outputContexts.push({
        name: `${sessionPath}/contexts/marcar_consulta_flow`,
        lifespanCount: state === "FINISHED" ? 0 : 5,
        parameters: {
          state,
          chosenSlot,
          clientName,
          clientEmail,
          clientPhone,
          availableSlots,
          currentIndex,
        },
      });
    }

    // Adiciona o contexto de "consultar_consulta_marcada_flow" se for relacionado
    if (intentName.startsWith("Consultar Consultas Marcadas")) {
      responseJson.outputContexts.push({
        name: `${sessionPath}/contexts/consultar_consulta_marcada_flow`,
        lifespanCount: state === "FINISHED" ? 0 : 5,
        parameters: {
          state,
          clientEmail,
          clientName,
          chosenSlot,
          clientPhone,
          availableSlots,
          currentIndex,
        },
      });
    }

    // Adiciona o contexto de "desmarcar_consulta_flow" se for relacionado
    if (intentName.startsWith("Desmarcar Consultas")) {
      responseJson.outputContexts.push({
        name: `${sessionPath}/contexts/desmarcar_consulta_flow`,
        lifespanCount: state === "FINISHED" ? 0 : 5,
        parameters: {
          state,
          clientEmail,
          clientName,
          chosenSlot,
          clientPhone,
          availableSlots,
          currentIndex,
        },
      });
    }

    console.log("Resposta enviada ao Dialogflow:", responseJson);
    res.json(responseJson);
  } catch (error) {
    console.error("Erro no Fulfillment:", error);
    res.status(500).send("Erro ao processar a intenção.");
  }
});

/**
 * Rota para receber mensagens do WhatsApp (via Twilio)
 */
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
    const audioUrl = req.body.MediaUrl0;
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

    // Se receber áudio, transcreve
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

    // Verifica estado atual
    const currentState = conversationStateMap[fromNumber]?.state || "";
    console.log("Estado atual da conversa para o usuário:", currentState);

    // Dependendo do estado, adiciona prefixos ("Meu e-mail é ...")
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

    // Envia ao Dialogflow
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

    // Tenta pegar o contexto do fluxo de marcar consulta
    const outputContexts =
      dialogflowResponse.data.queryResult.outputContexts || [];
    const flowContext = outputContexts.find((ctx: any) =>
      ctx.name.endsWith("marcar_consulta_flow")
    );
    let updatedState = flowContext?.parameters?.state || "";
    console.log("Novo estado retornado pelo Dialogflow:", updatedState);

    // Atualiza estado local
    conversationStateMap[fromNumber] = {
      state: updatedState,
    };

    // Envia a resposta ao usuário (quebrando em partes se for grande)
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

/**
 * Interface opcional para DialogflowContext
 */
interface DialogflowContext {
  name: string;
  lifespanCount: number;
  parameters: { [key: string]: any };
}
