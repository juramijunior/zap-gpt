import "dotenv/config";
import express from "express";
import { Request, Response } from "express";
import bodyParser from "body-parser";
import axios from "axios";
import qs from "qs";
import { transcribeAudio } from "./services/openai";

const app = express();
app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());

const WATSONX_ASSISTANT_ID = process.env.WATSONX_ASSISTANT_ID!;
const WATSONX_API_KEY = process.env.WATSONX_API_KEY!;
const WATSONX_URL = process.env.WATSONX_URL!;
// Ex: "https://api.us-south.assistant.watson.cloud.ibm.com/instances/<instance_id>"
// Obtido nas credenciais do seu serviço Watson Assistant clássico.

const WATSONX_VERSION = "2023-06-14"; // Ajuste a versão conforme a documentação atual da IBM

const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID!;
const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN!;
const TWILIO_PHONE_NUMBER = process.env.TWILIO_PHONE_NUMBER!;

// Função para dividir mensagens longas
function dividirMensagem(mensagem: string, tamanhoMax = 1600): string[] {
  const partes: string[] = [];
  for (let i = 0; i < mensagem.length; i += tamanhoMax) {
    partes.push(mensagem.substring(i, i + tamanhoMax));
  }
  return partes;
}

app.post("/webhook", async (req: Request, res: Response): Promise<void> => {
  try {
    const fromNumber = req.body.From;
    const incomingMessage = req.body.Body || "";
    const audioUrl = req.body.MediaUrl0;
    let finalUserMessage = incomingMessage;

    // Transcrição do áudio se houver
    if (audioUrl) {
      try {
        console.log(`Transcrevendo áudio da URL: ${audioUrl}`);
        finalUserMessage = await transcribeAudio(audioUrl);
        console.log(`Transcrição do áudio: ${finalUserMessage}`);
      } catch (error) {
        console.error("Erro ao transcrever o áudio:", error);
        res.status(500).send("Erro ao processar o áudio enviado.");
        return;
      }
    }

    // Criar sessão (API V2 Clássica)
    let sessionId: string;
    try {
      const sessionResponse = await axios.post(
        `${WATSONX_URL}/v2/assistants/${WATSONX_ASSISTANT_ID}/sessions?version=${WATSONX_VERSION}`,
        {},
        {
          headers: {
            Authorization:
              "Basic " +
              Buffer.from(`apikey:${WATSONX_API_KEY}`).toString("base64"),
            "Content-Type": "application/json",
          },
        }
      );
      sessionId = sessionResponse.data.session_id;
    } catch (error: any) {
      console.error("Erro ao criar sessão com o Watson Assistant:");
      if (error.response) {
        console.error("Status:", error.response.status);
        console.error("Data:", error.response.data);
      } else {
        console.error("Erro desconhecido:", error.message);
      }
      res.status(500).send("Erro ao criar sessão no Watson Assistant.");
      return;
    }

    // Envio da mensagem para o Assistant (API V2 Clássica)
    let watsonResponse;
    try {
      watsonResponse = await axios.post(
        `${WATSONX_URL}/v2/assistants/${WATSONX_ASSISTANT_ID}/sessions/${sessionId}/message?version=${WATSONX_VERSION}`,
        { input: { message_type: "text", text: finalUserMessage } },
        {
          headers: {
            Authorization:
              "Basic " +
              Buffer.from(`apikey:${WATSONX_API_KEY}`).toString("base64"),
            "Content-Type": "application/json",
          },
        }
      );
    } catch (error: any) {
      console.error("Erro ao enviar mensagem para o Watson Assistant:");
      if (error.response) {
        console.error("Status:", error.response.status);
        console.error("Data:", error.response.data);
      } else {
        console.error("Erro desconhecido:", error.message);
      }
      res.status(500).send("Erro ao processar a mensagem no Watson Assistant.");
      return;
    }

    const fullResponseMessage =
      watsonResponse.data.output?.generic
        ?.map((resp: any) => resp.text)
        .join("\n") || "Desculpe, não entendi.";

    // Enviar mensagem de volta pelo Twilio
    const partesMensagem = dividirMensagem(fullResponseMessage);
    for (const parte of partesMensagem) {
      const url = `https://api.twilio.com/2010-04-01/Accounts/${TWILIO_ACCOUNT_SID}/Messages.json`;
      const data = {
        To: fromNumber,
        From: `whatsapp:${TWILIO_PHONE_NUMBER}`,
        Body: parte,
      };

      try {
        await axios.post(url, qs.stringify(data), {
          auth: {
            username: TWILIO_ACCOUNT_SID,
            password: TWILIO_AUTH_TOKEN,
          },
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
        });
      } catch (error) {
        console.error("Erro ao enviar mensagem pelo Twilio:", error);
      }
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
