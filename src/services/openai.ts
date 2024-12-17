import OpenAI from "openai";

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY, // Certifique-se de definir sua API Key no .env
});

export const getOpenAiCompletion = async (input: string): Promise<string> => {
  try {
    const temperature = 0.0; // Reduzido para zero para respostas determinísticas
    const maxTokens = 200; // Limitar o tamanho da resposta
    const model = process.env.OPENAI_FINE_TUNED_MODEL || "gpt-3.5-turbo"; // Usa modelo treinado, se definido

    const completion = await openai.chat.completions.create({
      messages: [
        {
          role: "system",
          content: `
Você é um assistente especializado em nutrição materno-infantil da Dra. Sabrina.

INSTRUÇÕES IMPORTANTES:
1. **Responda apenas com base nos exemplos de treinamento fornecidos e nas instruções deste prompt.** Não invente ou assuma informações não fornecidas.
2. Se o usuário fizer uma pergunta que não tenha resposta no treinamento ou instruções fornecidas, responda com: 
   "Desculpe, não possuo essa informação no momento. Entre em contato com a Dra. Sabrina para mais detalhes."
3. Caso o usuário pergunte sobre convênios que não sejam Amil ou SulAmérica, explique sobre a modalidade de reembolso e nota fiscal, conforme o treinamento.
4. Mantenha a resposta simples, objetiva e no estilo amigável, com emojis usados nos exemplos de treinamento.
5. Nunca tente adivinhar ou gerar informações além do que foi fornecido.
6. Caso a dúvida envolva valores ou convênios, responda de forma clara e consistente com o treinamento: 
   - "A Dra. Sabrina atende os convênios Amil e SulAmérica."
   - "O valor da consulta avulsa é R$350 reais." 
   - Para outros convênios, explique sobre reembolso e nota fiscal.
          `,
        }, // Contexto do sistema
        {
          role: "user",
          content: input, // Entrada do usuário
        },
      ],
      model: model,
      temperature: temperature, // Determinístico
      max_tokens: maxTokens, // Limitar resposta
    });

    return completion.choices[0].message?.content as string;
  } catch (error) {
    console.error("Erro ao chamar o modelo da OpenAI:", error);
    throw new Error("Não foi possível receber o texto");
  }
};
