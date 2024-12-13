import axios, { AxiosResponse } from "axios";

const token = "<SEU_ACCESS_TOKEN>";
const phoneNumberId = "<PHONE_NUMBER_ID>";
const recipient = "<NUMERO_DESTINO>"; // Exemplo: '5561999998888'
const templateName = "hello_world";

axios
  .post(
    `https://graph.facebook.com/v16.0/${phoneNumberId}/messages`,
    {
      messaging_product: "whatsapp",
      to: recipient,
      type: "template",
      template: {
        name: templateName,
        language: { code: "en_US" },
      },
    },
    {
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
    }
  )
  .then((response: AxiosResponse) => {
    console.log("Mensagem enviada com sucesso:", response.data);
  })
  .catch((error) => {
    console.error(
      "Erro ao enviar mensagem:",
      error.response ? error.response.data : error.message
    );
  });
