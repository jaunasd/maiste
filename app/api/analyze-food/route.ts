import { NextRequest, NextResponse } from 'next/server';
import { GoogleGenAI, Type } from '@google/genai';

const foodItemSchema = {
  type: Type.OBJECT,
  properties: {
    name: { type: Type.STRING, description: 'Maisto pavadinimas lietuviškai' },
    calories: { type: Type.NUMBER, description: 'Kalorijos (kcal) per 100g' },
    protein: { type: Type.NUMBER, description: 'Baltymai (g) per 100g' },
    carbs: { type: Type.NUMBER, description: 'Angliavandeniai (g) per 100g' },
    fat: { type: Type.NUMBER, description: 'Riebalai (g) per 100g' },
    estimatedServing: { type: Type.NUMBER, description: 'Numatomas porcijos dydis gramais' },
  },
  required: ['name', 'calories', 'protein', 'carbs', 'fat', 'estimatedServing'],
};

const nutritionSchema = {
  type: Type.OBJECT,
  properties: {
    items: {
      type: Type.ARRAY,
      description: 'Visi nuotraukoje matomi maisto produktai ar patiekalai',
      items: foodItemSchema,
    },
  },
  required: ['items'],
};

function parseItems(text: string | null | undefined): { name: string; calories: number; protein: number; carbs: number; fat: number; estimatedServing: number }[] | null {
  if (!text) return null;
  try {
    const parsed = JSON.parse(text);
    const items = parsed?.items;
    if (Array.isArray(items) && items.length > 0) return items;
    return null;
  } catch {
    console.error('JSON parse klaida:', text?.slice(0, 200));
    return null;
  }
}

const imagePart = (mimeType: string, data: string) => ({ inlineData: { mimeType, data } });

export async function POST(req: NextRequest) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return NextResponse.json({ error: 'Gemini API raktas nenurodytas' }, { status: 500 });

  let base64Image: string;
  let mimeType: string;
  try {
    const body = await req.json();
    base64Image = body.base64Image;
    mimeType = body.mimeType || 'image/jpeg';
    if (!base64Image) return NextResponse.json({ error: 'Nuotrauka privaloma' }, { status: 400 });
  } catch {
    return NextResponse.json({ error: 'Blogas užklausos formatas' }, { status: 400 });
  }

  const ai = new GoogleGenAI({ apiKey });
  const img = imagePart(mimeType, base64Image);

  // ── 1. Flash — jei veikia, pasikliaujame jo rezultatu ────────────────────
  try {
    const r = await ai.models.generateContent({
      model: 'gemini-2.5-flash',
      contents: [{ role: 'user', parts: [img, { text: `Identifikuok VISUS maisto produktus šioje nuotraukoje. Kiekvienam pateik maistinę vertę per 100g ir porcijos dydį.` }] }],
      config: {
        responseMimeType: 'application/json',
        responseSchema: nutritionSchema,
        systemInstruction: 'Tu esi dietologas. Atpažink maistą nuotraukoje ir grąžink JSON. Naudok lietuviškus pavadinimus.',
      },
    });
    const items = parseItems(r.text) ?? [];
    console.log('Flash atsakė, rado:', items.length, 'produktų');
    return NextResponse.json({ items });
  } catch (e) {
    console.error('Flash klaida, pereinama prie Pro:', e);
  }

  // ── 2–4. Flash metė klaidą — bandome Pro ──────────────────────────────────
  const proPrompts = [
    `Pažiūrėk labai atidžiai – ankstesnis modelis nerado maisto. Identifikuok bet ką valgomą. Jei nežinai tiksliai – spėk pagal išvaizdą ir pateik apytikslę maistinę vertę su "(Panašu į ...)" pavadinime.`,
    `Dar vienas bandymas. Ieškoki maisto fone, lėkštėse, pakuotėse, net jei blogai matoma. Privalai grąžinti bent vieną produktą.`,
    `Paskutinis bandymas. Grąžink GERIAUSIĄ spėjimą pagal bet kokį matomą objektą. Naudok apytikslę maistinę vertę.`,
  ];

  for (let i = 0; i < proPrompts.length; i++) {
    try {
      console.log(`Pro bandymas ${i + 1}/3`);
      const r = await ai.models.generateContent({
        model: 'gemini-2.5-pro',
        contents: [{ role: 'user', parts: [img, { text: proPrompts[i] }] }],
        config: {
          responseMimeType: 'application/json',
          responseSchema: nutritionSchema,
          systemInstruction: 'Tu esi dietologas. Privalai rasti maistą nuotraukoje. Naudok lietuviškus pavadinimus. Visada grąžink bent vieną produktą.',
          thinkingConfig: { thinkingBudget: 1024 },
        },
      });
      const items = parseItems(r.text);
      if (items) {
        console.log(`Pro bandymas ${i + 1} rado:`, items.length, 'produktų');
        return NextResponse.json({ items });
      }
      console.log(`Pro bandymas ${i + 1}: tuščia`);
    } catch (e) {
      console.error(`Pro bandymas ${i + 1} klaida:`, e);
    }
  }

  // ── 5. Patikrinti ar čia apskritai maistas ─────────────────────────────────
  try {
    const check = await ai.models.generateContent({
      model: 'gemini-2.5-flash',
      contents: [{ role: 'user', parts: [img, { text: 'Ar šioje nuotraukoje yra maistas, gėrimas ar maisto produktas? Atsakyk tik "taip" arba "ne".' }] }],
    });
    const answer = (check.text ?? '').toLowerCase();
    console.log('Maisto patikrinimas:', answer);
    if (!answer.startsWith('taip') && !answer.includes('yes')) {
      return NextResponse.json({ error: 'Nuotraukoje maisto nerasta. Nufotografuokite maistą.' }, { status: 422 });
    }
  } catch (e) {
    console.error('Maisto patikrinimo klaida:', e);
  }

  // Maistas yra, bet nepavyko tiksliai identifikuoti
  return NextResponse.json({
    items: [{
      name: 'Neatpažintas maistas',
      calories: 150,
      protein: 5,
      carbs: 20,
      fat: 5,
      estimatedServing: 100,
    }],
  });
}
