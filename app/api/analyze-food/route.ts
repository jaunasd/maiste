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

const imagePart = (mimeType: string, data: string) => ({ inlineData: { mimeType, data } });

async function tryFlash(ai: GoogleGenAI, mimeType: string, base64Image: string) {
  const response = await ai.models.generateContent({
    model: 'gemini-2.5-flash',
    contents: [{
      role: 'user',
      parts: [
        imagePart(mimeType, base64Image),
        { text: `Identifikuok VISUS maisto produktus ar patiekalus šioje nuotraukoje.
Jei ant lėkštės yra keli skirtingi patiekalai ar produktai – grąžink kiekvieną atskirai.
Jei tai pakuotė su maistine lentele – nuskaityk ją tiksliai.
Kiekvienam produktui pateik maistinę vertę per 100g ir numatomą porcijos dydį.` },
      ],
    }],
    config: {
      responseMimeType: 'application/json',
      responseSchema: nutritionSchema,
      systemInstruction: `Tu esi profesionalus dietologas, išmanantis lietuvišką rinką ir produktus.
Atpažink VISUS maisto produktus nuotraukoje. Jei matai kelis skirtingus patiekalus ar produktus – išvardyk kiekvieną atskirai.
Naudok lietuviškus pavadinimus.`,
    },
  });
  if (!response.text) return null;
  const result = JSON.parse(response.text);
  return result.items?.length > 0 ? result : null;
}

async function tryPro(ai: GoogleGenAI, mimeType: string, base64Image: string, attempt: number) {
  const prompts = [
    `Ankstesnis bandymas nerado maisto. Analizuok labai atidžiai.
Pažiūrėk į visus objektus – net jei jie atrodo neįprasti, blogai apšviesti ar sunkiai atpažįstami.
Grąžink VISKĄ, kas gali būti maistas arba gėrimas. Geriau grąžinti panašiausią atitikmenį nei nieko.
Jei tiksliai nežinai produkto – prirašyk "(Panašu į ...)" ir pateik apytikslę maistinę vertę pagal išvaizdą.`,

    `Atlikta keli bandymai, bet maisto nerasta. Paskutinis bandymas.
Pažiūrėk iš naujo – galbūt maistas yra fone, ant stalo, lėkštėje ar pakuotėje.
Net jei matai tik dalį produkto ar neaiškią formą – identifikuok pagal spalvą, tekstūrą, formą.
PRIVALAI grąžinti bent vieną produktą su apytiksliais duomenimis. Naudok geriausią spėjimą.`,

    `Kritinis bandymas. Tavo vienintelė užduotis – surasti BET KĮ valgomo šioje nuotraukoje.
Jei matai stalą su indais – spėk kas galėjo būti patiekta.
Jei matai pakuotę – identifikuok pagal spalvas ar formą.
Jei matai ką nors rudą/geltoną/žalią – spėk kokia tai gali būti maisto grupė.
Grąžink spėjimą su "(Apytikslis spėjimas)" pavadinime.`,
  ];

  const prompt = prompts[Math.min(attempt, prompts.length - 1)];

  const response = await ai.models.generateContent({
    model: 'gemini-2.5-pro',
    contents: [{
      role: 'user',
      parts: [
        imagePart(mimeType, base64Image),
        { text: prompt },
      ],
    }],
    config: {
      responseMimeType: 'application/json',
      responseSchema: nutritionSchema,
      systemInstruction: `Tu esi dietologas. Privalai nuotraukoje atrasti maistą, net jei jis sunkiai atpažįstamas.
Naudok lietuviškus pavadinimus. Jei tiksliai nežinai, prirašyk "(Panašu į ...)".
NIEKADA negrąžink tuščio sąrašo – visada pateik bent vieną geriausią spėjimą.`,
    },
  });
  if (!response.text) return null;
  const result = JSON.parse(response.text);
  return result.items?.length > 0 ? result : null;
}

async function isFood(ai: GoogleGenAI, mimeType: string, base64Image: string): Promise<boolean> {
  const response = await ai.models.generateContent({
    model: 'gemini-2.5-flash',
    contents: [{
      role: 'user',
      parts: [
        imagePart(mimeType, base64Image),
        { text: 'Ar šioje nuotraukoje yra kokio nors maisto, gėrimų, indų su maistu, maisto pakuočių ar bet ko suvalgomo? Atsakyk tik "taip" arba "ne".' },
      ],
    }],
  });
  const answer = (response.text ?? '').toLowerCase().trim();
  return answer.startsWith('taip') || answer.includes('yes');
}

export async function POST(req: NextRequest) {
  try {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) return NextResponse.json({ error: 'Gemini API raktas nenurodytas' }, { status: 500 });
    const ai = new GoogleGenAI({ apiKey });

    const { base64Image, mimeType = 'image/jpeg' } = await req.json();
    if (!base64Image) return NextResponse.json({ error: 'Nuotrauka privaloma' }, { status: 400 });

    // 1. Flash — greitas bandymas
    const flashResult = await tryFlash(ai, mimeType, base64Image);
    if (flashResult) return NextResponse.json(flashResult);

    // 2. Pro — iki 3 bandymų su vis agresyvesniais prompt'ais
    for (let attempt = 0; attempt < 3; attempt++) {
      console.log(`Pro bandymas ${attempt + 1}/3...`);
      const proResult = await tryPro(ai, mimeType, base64Image, attempt);
      if (proResult) return NextResponse.json(proResult);
    }

    // 3. Po visų bandymų — patikriname ar čia apskritai maistas
    const food = await isFood(ai, mimeType, base64Image);
    if (!food) {
      return NextResponse.json({ error: 'Nuotraukoje maisto nerasta. Nufotografuokite maistą arba gėrimą.' }, { status: 422 });
    }

    // Maistas yra, bet nepavyko identifikuoti — grąžiname bendrą atsakymą
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
  } catch (error) {
    console.error('Analyze food error:', error);
    return NextResponse.json({ error: 'Nepavyko išanalizuoti nuotraukos' }, { status: 500 });
  }
}
