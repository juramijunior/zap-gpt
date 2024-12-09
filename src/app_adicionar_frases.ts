import { GoogleAuth } from "google-auth-library";
import axios from "axios";

// Configuração
const DIALOGFLOW_PROJECT_ID = process.env.DIALOGFLOW_PROJECT_ID;
const credentialsJson = process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON;

if (!DIALOGFLOW_PROJECT_ID || !credentialsJson) {
  throw new Error(
    "Verifique as variáveis DIALOGFLOW_PROJECT_ID e GOOGLE_APPLICATION_CREDENTIALS_JSON."
  );
}

const auth = new GoogleAuth({
  credentials: JSON.parse(credentialsJson),
  scopes: ["https://www.googleapis.com/auth/dialogflow"],
});

// Função para adicionar frases de treinamento
async function addTrainingPhrases(intentName: string, phrases: string[]) {
  try {
    // Autenticação
    const client = await auth.getClient();
    const token = await client.getAccessToken();

    // Lista intenções
    const response = await axios.get(
      `https://dialogflow.googleapis.com/v2/projects/${DIALOGFLOW_PROJECT_ID}/agent/intents`,
      {
        headers: {
          Authorization: `Bearer ${token.token}`,
        },
      }
    );

    const intents = response.data.intents;

    // Localiza a intenção pelo nome
    const intent = intents.find((i: any) => i.displayName === intentName);
    if (!intent) {
      throw new Error(`Intenção '${intentName}' não encontrada.`);
    }

    // Atualiza as frases de treinamento
    const updatedIntent = {
      ...intent,
      trainingPhrases: [
        ...(intent.trainingPhrases || []),
        ...phrases.map((text) => ({
          type: "EXAMPLE",
          parts: [{ text }],
        })),
      ],
    };

    // Atualiza a intenção
    await axios.patch(
      `https://dialogflow.googleapis.com/v2/projects/${DIALOGFLOW_PROJECT_ID}/agent/intents/${intent.name
        .split("/")
        .pop()}`,
      updatedIntent,
      {
        headers: {
          Authorization: `Bearer ${token.token}`,
          "Content-Type": "application/json",
        },
      }
    );

    console.log(`Frases adicionadas à intenção: ${intentName}`);
  } catch (error: any) {
    if (axios.isAxiosError(error)) {
      // Erro gerado pelo Axios
      console.error(
        "Erro ao adicionar frases:",
        error.response?.data || error.message
      );
    } else {
      // Outros tipos de erro
      console.error("Erro inesperado:", error);
    }
  }
}

// Testando a função
(async () => {
  const intentName = "Agendamento de Consultas"; // Nome da intenção
  const phrases = [
    "Gostaria de marcar uma consulta.",
    "Preciso remarcar meu horário.",
    "Quais horários estão disponíveis?",
  ]; // Frases de exemplo

  await addTrainingPhrases(intentName, phrases);
})();
