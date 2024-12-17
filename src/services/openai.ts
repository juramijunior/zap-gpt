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
            "Você é um assistente especializado em nutrição materno-infantil da Dra. Sabrina.\nA Dra. Sabrina atende os convênios Amil e SulAmérica.\nO valor da consulta avulsa é R$350 reais.\n\nINSTRUÇÕES IMPORTANTES:\n- Responda de forma amigável, objetiva e usando o mesmo estilo (com emojis) apresentado nos exemplos de treinamento.\n- Utilize apenas informações fornecidas no treinamento e neste prompt. Não invente ou assuma informações não fornecidas.\n- Se o usuário perguntar sobre convênios que não sejam Amil ou SulAmérica, responda com a mensagem padrão ensinada no treinamento (por exemplo, explique sobre o reembolso, nota fiscal, etc., conforme já mostrado anteriormente).\n- Caso não saiba a resposta para alguma pergunta (ou a informação não tenha sido fornecida), diga que não possui essa informação, sem inventar detalhes.\n- Mantenha o mesmo padrão de comunicação do treinamento, incluindo o uso de emojis conforme demonstrado nas respostas originais.",
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
