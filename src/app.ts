import "dotenv/config";
import express, { Request, Response } from "express";
const bodyParser = require("body-parser");
const axios = require("axios");
const { Twilio } = require("twilio");
const { GoogleAuth } = require("google-auth-library"); // Importando Google Auth

const app = express();
app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());

// Configuração do Twilio
const accountSid = process.env.TWILIO_ACCOUNT_SID;
const authToken = process.env.TWILIO_AUTH_TOKEN;
const twilioClient = new Twilio(accountSid, authToken);
// Configuração do Google Auth com Dialogflow
const auth = new GoogleAuth({
  keyFile: "./src/services/credenciais.json", // Substitua pelo caminho do arquivo JSON
  scopes: ["https://www.googleapis.com/auth/dialogflow"],
});

const DIALOGFLOW_PROJECT_ID = process.env.DIALOGFLOW_PROJECT_ID;
const DIALOGFLOW_SESSION_ID =
  process.env.DIALOGFLOW_SESSION_ID || "sessao-unique";

// Rota Webhook para receber mensagens do Twilio
app.post("/webhook", async (req, res) => {
  const incomingMessage = req.body.Body; // Mensagem recebida do WhatsApp
  const fromNumber = req.body.From; // Número do remetente

  try {
    // Obtém o token de acesso dinamicamente
    const client = await auth.getClient();
    const accessToken = await client.getAccessToken();

    // Envia a mensagem para o Dialogflow
    const dialogflowResponse = await axios.post(
      `https://dialogflow.googleapis.com/v2/projects/${DIALOGFLOW_PROJECT_ID}/agent/sessions/${DIALOGFLOW_SESSION_ID}:detectIntent`,
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

    // Envia a resposta ao WhatsApp via Twilio
    await twilioClient.messages.create({
      from: "whatsapp:+14155238886", // Número do Twilio para WhatsApp
      to: fromNumber, // Número do usuário que enviou a mensagem
      body: responseMessage,
    });

    res.status(200).send("Mensagem processada com sucesso");
  } catch (error) {
    console.error("Erro:", error);
    res.status(500).send("Erro ao processar a mensagem");
  }
});

// Iniciar o servidor
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Servidor rodando na porta ${PORT}`);
});
