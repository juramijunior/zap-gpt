import OpenAI from "openai";

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY, // Certifique-se de definir sua API Key no .env
});

export const getOpenAiCompletion = async (input: string): Promise<string> => {
  try {
    const temperature = 0.1;
    const model = process.env.OPENAI_FINE_TUNED_MODEL || "gpt-3.5-turbo"; // Usa modelo treinado, se definido

    const completion = await openai.chat.completions.create({
      messages: [
        {
          role: "system",
          content:
            "Você é um assistente especializado em nutrição materno-infantil. A Dra. Sabrina atende os convênios Amil e SulAmérica. O valor da consulta avulsa é R$350 reais. Responda de forma amigável e objetiva.",
        }, // Contexto do sistema
        { role: "user", content: input },
      ],
      model: model,
      temperature: temperature,
    });

    return completion.choices[0].message?.content as string;
  } catch (error) {
    console.error("Erro ao chamar o modelo da OpenAI:", error);
    throw new Error("Não foi possível receber o texto");
  }
};
