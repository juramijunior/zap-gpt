import express from "express";
import axios, { AxiosError } from "axios";

const app = express();
app.use(express.json());

// Variáveis de ambiente
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN || "EAAG...";
const WHATSAPP_PHONE_NUMBER_ID =
  process.env.WHATSAPP_PHONE_NUMBER_ID || "5485985016xxxxx";

app.post("/send-whatsapp", async (req, res) => {
  try {
    // Número do destinatário no formato E.164 (ex.: "5561999999999" para +55 61 99999-9999)
    const toNumber = req.body.to;

    // Mensagem que você quer enviar
    const messageBody = req.body.message;

    // Monta a chamada
    const url = `https://graph.facebook.com/v17.0/${WHATSAPP_PHONE_NUMBER_ID}/messages`;
    const data = {
      messaging_product: "whatsapp",
      to: toNumber,
      text: {
        body: messageBody,
      },
    };

    // Faz a requisição POST com o token de acesso
    const response = await axios.post(url, data, {
      headers: {
        Authorization: `Bearer ${WHATSAPP_TOKEN}`,
        "Content-Type": "application/json",
      },
    });

    console.log("Resposta do WhatsApp API:", response.data);
    res.json({ success: true, data: response.data });
  } catch (error) {
    if (error instanceof AxiosError) {
      // Trata erros específicos do Axios
      console.error(
        "Erro ao enviar mensagem:",
        error.response?.data || error.message
      );
      res
        .status(500)
        .json({ success: false, error: error.response?.data || error.message });
    } else if (error instanceof Error) {
      // Trata erros genéricos
      console.error("Erro ao enviar mensagem:", error.message);
      res.status(500).json({ success: false, error: error.message });
    } else {
      // Caso o erro não seja do tipo esperado
      console.error("Erro desconhecido:", error);
      res.status(500).json({ success: false, error: "Erro desconhecido" });
    }
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Servidor rodando na porta ${PORT}`);
});
