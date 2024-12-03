import { Twilio } from "twilio";
const accountSid = process.env.TWILIO_ACCOUNT_SID;
const authToken = process.env.TWILIO_AUTH_TOKEN;
const WhatsappPhoneNumber = process.env.WhatsappPhoneNumber;
if (!accountSid || !authToken) {
  throw new Error("Twilio Account SID ou Auth Token não configurados.");
}

const client = new Twilio(accountSid, authToken);

export const sendWhatsappMessage = async (to: string, body: string) => {
  try {
    const message = await client.messages.create({
      to: to,
      from: WhatsappPhoneNumber,
      body,
    });
  } catch (error) {
    console.error("Erro ao enviar mensagem", error);
  }
};
