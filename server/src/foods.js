// Tabella piccola di cibi comuni (valori medi per 100 g, crudi dove non detto) per non lasciare un ingrediente
// senza calorie quando il modello se le dimentica (es. la piadina di un kebab fatto in casa).
// Sono stime da etichetta media: servono a non far sparire un ingrediente dal totale, non a sostituire la bilancia.
// piece: grammi di un pezzo ("1 piadina", "2 uova"); spoon: grammi di un cucchiaio se diverso da 10.

const F = (re, kcal, protein, carbs, fat, extra = {}) => ({ re, kcal, protein, carbs, fat, ...extra });

export const FOODS = [
  F(/\b(sale|pepe|acqua|spezie|origano|basilico|prezzemolo|rosmarino|paprika|curry|curcuma|cumino|aglio in polvere|aceto)\b/, 0, 0, 0, 0),
  F(/\bpiadin[ae]\b/, 300, 8, 48, 9, { piece: 110 }),
  F(/\b(tortilla|tortillas|wrap)\b/, 300, 8.5, 50, 7.5, { piece: 60 }),
  F(/\b(pane arabo|pita|pane pita)\b/, 275, 9, 55, 1.2, { piece: 70 }),
  F(/\bkebab\b|\bdoner\b|\bgyros\b/, 230, 18, 3, 16),
  F(/\b(salsa yogurt|salsa allo yogurt|tzatziki)\b/, 110, 4, 5, 8, { spoon: 15 }),
  F(/\byogurt greco (0|zero|magro)\b|\byogurt greco 0%/, 57, 10, 4, 0.2, { piece: 170 }),
  F(/\byogurt greco\b/, 97, 9, 4, 5, { piece: 170 }),
  F(/\byogurt\b|\byogurth?\b/, 61, 3.5, 4.7, 3.3, { piece: 125 }),
  F(/\bpett[oi] di pollo\b/, 110, 23, 0, 1.5),
  F(/\bpollo\b/, 140, 21, 0, 6),
  F(/\btacchino\b/, 107, 24, 0, 1),
  F(/\b(carne macinata|macinato)\b/, 200, 20, 0, 13),
  F(/\b(manzo|bovino|vitello|hamburger)\b/, 190, 21, 0, 12, { piece: 120 }),
  F(/\bmaiale\b|\blonza\b/, 160, 21, 0, 8),
  F(/\bprosciutto cotto\b/, 135, 20, 1, 5),
  F(/\bprosciutto crudo\b|\bspeck\b/, 250, 26, 0, 16),
  F(/\bbresaola\b/, 150, 32, 0, 2),
  F(/\b(salmone)\b/, 208, 20, 0, 13),
  F(/\btonno\b/, 110, 24, 0, 1.5, { piece: 56 }),
  F(/\b(uova|uovo|tuorl[oi])\b/, 143, 12.6, 0.7, 9.5, { piece: 60 }),
  F(/\balbum[ei]?\b/, 52, 11, 0.7, 0.2, { piece: 33 }),
  F(/\bmozzarella\b/, 250, 18, 2, 19, { piece: 125 }),
  F(/\b(parmigiano|grana)\b/, 392, 33, 0, 28, { spoon: 5 }),
  F(/\b(feta)\b/, 265, 14, 4, 21),
  F(/\b(formaggio spalmabile|philadelphia|ricotta)\b/, 180, 8, 4, 14, { spoon: 15 }),
  F(/\b(cheddar|emmental|formaggio)\b/, 380, 25, 1, 31, { piece: 20 }),
  F(/\blatte\b/, 46, 3.3, 4.9, 1.6),
  F(/\b(olio|olio d'oliva|olio di oliva|olio evo)\b/, 884, 0, 0, 100),
  F(/\bburro\b/, 717, 0.9, 0.1, 81),
  F(/\b(maionese)\b/, 680, 1, 1, 75, { spoon: 15 }),
  F(/\b(ketchup)\b/, 110, 1.5, 26, 0.2, { spoon: 15 }),
  F(/\b(zucchero)\b/, 400, 0, 100, 0, { spoon: 12 }),
  F(/\b(miele)\b/, 304, 0.3, 82, 0, { spoon: 20 }),
  F(/\bpasta\b|\bspaghetti\b|\bpenne\b|\bfusilli\b|\brigatoni\b/, 355, 12.5, 72, 1.5),
  F(/\briso\b/, 360, 7, 80, 0.6),
  F(/\b(pane|pan bauletto|pancarr[eè])\b/, 265, 9, 49, 3.2, { piece: 50 }),
  F(/\b(farina)\b/, 345, 11, 72, 1.2),
  F(/\b(avena|fiocchi d'avena)\b/, 370, 13, 60, 7),
  F(/\bpatat[ae]\b/, 77, 2, 17, 0.1, { piece: 170 }),
  F(/\b(ceci)\b/, 164, 9, 27, 2.6),
  F(/\b(lenticchie)\b/, 116, 9, 20, 0.4),
  F(/\b(fagioli)\b/, 127, 8.7, 22, 0.5),
  F(/\b(passata|pelati|polpa di pomodoro)\b/, 30, 1.3, 5, 0.2),
  F(/\bpomodor[oi]\b|\bpomodorini\b/, 18, 0.9, 3.9, 0.2, { piece: 120 }),
  F(/\b(insalata|lattuga|rucola|spinaci|cavolo|cappuccio)\b/, 18, 1.6, 2.9, 0.3),
  F(/\bcipoll[ae]\b/, 40, 1.1, 9, 0.1, { piece: 110 }),
  F(/\b(zucchin[ae]|zucchine)\b/, 17, 1.2, 3.1, 0.3, { piece: 200 }),
  F(/\bcarot[ae]\b/, 41, 0.9, 10, 0.2, { piece: 80 }),
  F(/\bpeperon[ei]\b/, 26, 1, 6, 0.3, { piece: 160 }),
  F(/\b(funghi|champignon)\b/, 22, 3.1, 3.3, 0.3),
  F(/\bcetriol[oi]\b/, 15, 0.7, 3.6, 0.1, { piece: 200 }),
  F(/\bbanan[ae]\b/, 89, 1.1, 23, 0.3, { piece: 120 }),
  F(/\bmel[ae]\b/, 52, 0.3, 14, 0.2, { piece: 180 }),
  F(/\bavocado\b/, 160, 2, 9, 15, { piece: 150 }),
];

const norm = (t) => String(t || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/\s+/g, ' ').trim();

/** Il cibo della tabella che corrisponde al nome, o null. Il primo che combacia vince (i più specifici sono sopra). */
export function findFood(name) {
  const t = norm(name);
  return t ? FOODS.find(f => f.re.test(t)) || null : null;
}

const NUM = '(\\d+(?:[.,]\\d+)?|mezz[oa]|un[oa]?|due|tre|quattro|cinque|sei)';
const WORDS = { mezzo: 0.5, mezza: 0.5, un: 1, uno: 1, una: 1, due: 2, tre: 3, quattro: 4, cinque: 5, sei: 6 };
const num = (v) => (v in WORDS ? WORDS[v] : Number(String(v).replace(',', '.')));

/**
 * Grammi di una dose scritta ("250 g", "0,2 kg", "1 cucchiaio", "2 uova", "1 piadina"). 0 se non si capisce o è "q.b.".
 * food serve per i pezzi e per il peso del cucchiaio.
 */
export function gramsOf(qty, food = null) {
  const q = norm(qty);
  if (!q || /\bq\.?\s?b\.?\b|quanto basta/.test(q)) return 0;
  let m = new RegExp(`${NUM}\\s*(kg|chili|chilo)\\b`).exec(q);
  if (m) return num(m[1]) * 1000;
  m = new RegExp(`${NUM}\\s*(g|gr|grammi|grammo|ml|millilitri)\\b`).exec(q) || /(\d+(?:[.,]\d+)?)(g|gr|ml)\b/.exec(q);
  if (m) return num(m[1]);
  m = new RegExp(`${NUM}\\s*(cucchiain[oi])\\b`).exec(q);
  if (m) return num(m[1]) * Math.round((food?.spoon || 10) * 0.4);
  m = new RegExp(`${NUM}\\s*(cucchiaio|cucchiai)\\b`).exec(q);
  if (m) return num(m[1]) * (food?.spoon || 10);
  m = new RegExp(`^${NUM}\\b`).exec(q);
  if (m && food?.piece) return num(m[1]) * food.piece;
  return 0;
}

/** Valori di una dose di quel cibo, arrotondati. */
export function estimate(food, grams) {
  const k = grams / 100;
  const r1 = (v) => Math.round(v * k * 10) / 10;
  return { kcal: Math.round(food.kcal * k), protein: r1(food.protein), carbs: r1(food.carbs), fat: r1(food.fat) };
}
