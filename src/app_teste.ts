import "dotenv/config";
import express, { Request, Response } from "express";
import bodyParser from "body-parser";
import axios from "axios";
import { Twilio } from "twilio";
import { GoogleAuth } from "google-auth-library";
import * as uuid from "uuid";

// Verifica se as credenciais do Google foram configuradas
const credentialsJson = process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON;
if (!credentialsJson) {
  throw new Error("As credenciais do Google não estão definidas.");
}

// Parse das credenciais do Google
const parsedCredentials = JSON.parse(credentialsJson);

// Configurações básicas
const app = express();
app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());

// Configuração do Twilio
const accountSid = process.env.TWILIO_ACCOUNT_SID;
const authToken = process.env.TWILIO_AUTH_TOKEN;
const twilioClient = new Twilio(accountSid, authToken);

// Configuração do Google Auth
const auth = new GoogleAuth({
  credentials: parsedCredentials,
  scopes: ["https://www.googleapis.com/auth/dialogflow"],
});

// Configuração do Dialogflow
const DIALOGFLOW_PROJECT_ID = process.env.DIALOGFLOW_PROJECT_ID_BOOT;

// Carrega as frases do arquivo JSON gerado anteriormente
const trainingData = [
  {
    name: "Dúvidas sobre Atendimento e Preços",
    phrases: [
      "Qual é o preço da consulta?",
      "Como funciona o atendimento?",
      "Vocês aceitam pagamento por cartão?",
    ],
  },
  {
    name: "Agendamento de Consultas",
    phrases: [
      "Gostaria de marcar uma consulta.",
      "Preciso remarcar meu horário.",
      "Quais horários estão disponíveis?",
    ],
  },
];

// Função para adicionar frases de treinamento a uma intenção
async function addTrainingPhrasesFromJSON() {
  const client = await auth.getClient();
  const accessToken = await client.getAccessToken();

  try {
    // Obtém a lista de intenções
    const intentsResponse = await axios.get(
      `https://dialogflow.googleapis.com/v2/projects/${DIALOGFLOW_PROJECT_ID}/agent/intents`,
      {
        headers: {
          Authorization: `Bearer ${accessToken.token}`,
        },
      }
    );

    const intents = intentsResponse.data.intents;

    for (const intentData of trainingData) {
      const intent = intents.find(
        (i: any) => i.displayName === intentData.name
      );

      if (!intent) {
        console.error(`Intenção '${intentData.name}' não encontrada.`);
        continue;
      }

      // Adiciona frases de treinamento
      const updatedIntent = {
        ...intent,
        trainingPhrases: [
          ...(intent.trainingPhrases || []),
          ...intentData.phrases.map((text) => ({
            type: "EXAMPLE",
            parts: [{ text }],
          })),
        ],
      };

      // Atualiza a intenção no Dialogflow
      await axios.patch(
        `https://dialogflow.googleapis.com/v2/projects/${DIALOGFLOW_PROJECT_ID}/agent/intents/${intent.name}`,
        updatedIntent,
        {
          headers: {
            Authorization: `Bearer ${accessToken.token}`,
            "Content-Type": "application/json",
          },
        }
      );

      console.log(`Frases adicionadas à intenção: ${intentData.name}`);
    }
  } catch (error) {
    console.error("Erro ao adicionar frases de treinamento:", error);
  }
}

// Iniciar o servidor e adicionar frases ao inicializar
const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => {
  console.log(`Servidor rodando na porta ${PORT}`);
  await addTrainingPhrasesFromJSON(); // Adiciona frases de treinamento ao iniciar
});
