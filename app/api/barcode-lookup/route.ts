import { NextRequest, NextResponse } from 'next/server';
import { GoogleGenAI } from '@google/genai';

export async function POST(req: NextRequest) {
  try {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) return NextResponse.json({ error: 'API raktas nenurodytas' }, { status: 500 });
    const ai = new GoogleGenAI({ apiKey });

    const { base64Image, mimeType = 'image/jpeg' } = await req.json();
    if (!base64Image) return NextResponse.json({ error: 'Nuotrauka privaloma' }, { status: 400 });

    const response = await ai.models.generateContent({
      model: 'gemini-2.5-pro',
      contents: [
        {
          role: 'user',
          parts: [
            { inlineData: { mimeType, data: base64Image } },
            {
              text: `Nuotraukoje yra maisto produkto barkodas. Atlik šiuos veiksmus:

1. Nuskaityk barkodo numerį iš nuotraukos (EAN-13, EAN-8, UPC-A arba kitą formatą).
2. Identifikuok produktą pagal barkodo numerį – naudok savo žinias apie pasaulinius ir Lietuviškus produktus.
3. Grąžink TIKTAI šį JSON (be jokio papildomo teksto):

{
  "barcode": "barkodo skaičiai",
  "found": true,
  "name": "produkto pavadinimas lietuviškai",
  "brand": "gamintojo pavadinimas",
  "calories": <skaičius kcal per 100g>,
  "protein": <skaičius g per 100g>,
  "carbs": <skaičius g per 100g>,
  "fat": <skaičius g per 100g>,
  "estimatedServing": <tipiška porcija gramais>
}

Jei produkto NEPAVYKO identifikuoti pagal barkodą (bet barkodas nuskaitytas), grąžink:
{
  "barcode": "barkodo skaičiai",
  "found": false
}

Jei barkodas VISIŠKAI NEMATOMAS arba nuotraukoje nėra barkodo, grąžink:
{
  "barcode": null,
  "found": false
}

Svarbu: naudok tikrą maistinę vertę iš etiketės žinių. Porcija – tipiškas vieno karto naudojimas (pvz. 200ml gėrimui, 100g sūriui, 40g duonos riekelei).`,
            },
          ],
        },
      ],
      config: {
        responseMimeType: 'application/json',
      },
    });

    const text = response.text;
    if (!text) throw new Error('Tuščias atsakymas');

    return NextResponse.json(JSON.parse(text));
  } catch (error) {
    console.error('Barcode lookup error:', error);
    return NextResponse.json({ error: 'Nepavyko nuskaityti barkodo' }, { status: 500 });
  }
}
