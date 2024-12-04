import OpenAI from "openai";

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

export const getOpenAiCompletion = async (input: string): Promise<string> => {
  try {
    const temperature = 0.7;
    const prompt = "Summarize:";
    const model = "gpt-3.5-turbo";

    const completion = await openai.chat.completions.create({
      messages: [{ role: "user", content: input }],
      model: model,
      temperature: temperature,
    });

    return completion.choices[0].message?.content as string;
  } catch {
    throw new Error("Não foi possível receber o texto");
    return "";
  }
};
