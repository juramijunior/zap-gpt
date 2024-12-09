import "dotenv/config";
import express, { Request, Response } from "express";
const bodyParser = require("body-parser");
const axios = require("axios");
const { Twilio } = require("twilio");
const { GoogleAuth } = require("google-auth-library");
import { google } from "googleapis";
import * as uuid from "uuid";

// teste Validação das credenciais do Google
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
  scopes: ["https://www.googleapis.com/auth/dialogflow"],
});

const DIALOGFLOW_PROJECT_ID = process.env.DIALOGFLOW_PROJECT_ID;

const app = express();
app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());

// Função para lidar com Fulfillment do Dialogflow
app.post("/fulfillment", async (req: Request, res: Response) => {
  const intentName = req.body.queryResult.intent.displayName;

  try {
    let responseText = "Desculpe, não entendi sua solicitação.";

    // Processar lógica personalizada com base na intenção
    switch (intentName) {
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
    // Obter token de acesso do Google
    const client = await auth.getClient();
    const accessToken = await client.getAccessToken();
    const sessionId = uuid.v4(); // Criar ID de sessão único para cada interação

    // Enviar mensagem para o Dialogflow
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

    // Enviar resposta ao usuário via WhatsApp (Twilio)
    await twilioClient.messages.create({
      from: "whatsapp:+14155238886", // Número do Twilio
      to: fromNumber, // Número do usuário
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
});
