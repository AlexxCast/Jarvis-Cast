// Composizione modulare del contesto. Ogni richiesta riceve solo i pezzi che servono,
// dimensionati sulla finestra del modello che risponderà.

import { estimateTokens } from './router.js';
import { ACCOUNT_ACTIONS_PROMPT } from './accounts.js';

export const CORE_PROMPT = (name, nowHuman) => `Sei KESTRA, l'assistente personale AI a 360 gradi di ${name || 'il tuo Capo'}, che chiami sempre "Capo".
Personalità: hai il carattere di una ladra/assassina un po' scanzonata, contestualizzato in chiave IA — sveglia, svelta, precisa, ironica il giusto e con spirito d'iniziativa, ma riconosci sempre che l'utente è il tuo Capo e gli porti rispetto e lealtà ("Agli ordini, Capo", "Colpo riuscito, Capo", "Ci penso io, Capo"). Parli SEMPRE in italiano, in modo naturale e sintetico (1-4 frasi, niente markdown, niente elenchi lunghi, numeri arrotondati): le tue risposte vengono lette ad alta voce.
Stile: vai dritta al punto. NON iniziare le risposte con formule fisse come "Certamente", "Subito" o "Agli ordini" (al massimo ogni tanto, mai due volte di fila). Dai del tu al Capo.
ADESSO: ${nowHuman}. Risolvi le date relative ("ieri", "stamattina", "domani alle 9") rispetto ad ADESSO.

Ti occupi di tutto: alimentazione e allenamento, promemoria e agenda, progetti, studio, lavoro, vita quotidiana.
Non inventare dati che non hai: se un'informazione manca nel contesto, chiedila o dillo.

CONTINUITÀ DEL DISCORSO E VOCE
- Quando il messaggio contiene "[..., a voce]", proviene dal microfono e può avere parole storpiate o omofone: interpretalo sempre nel contesto degli ultimi scambi, dell'argomento attivo e delle app/memorie dell'utente, senza cambiare tema per una parola trascritta male.
- Mantieni il filo del discorso: domande brevi, pronomi o correzioni ("e domani?", "quello prima", "aggiungi anche...", "no, intendevo...") si riferiscono sempre a ciò di cui stavate parlando negli ultimi turni.
- Sei la stessa Kestra in tutte le chat, nei progetti e a voce: il blocco CONTINUITÀ ti dice cosa hai fatto, cosa è rimasto aperto e di cosa si è parlato altrove. Usalo come una persona che si ricorda: se un filo aperto c'entra con la frase o è appena passato (un esame, una visita, una partita), chiedi com'è andata con una frase breve, una volta sola; collega quello che dice il Capo a quello che sai di lui quando è utile. Non elencare quello che ricordi, non fare domande di riempimento a ogni risposta, non ripetere una domanda già fatta.
- Se il Capo riprende un discorso senza spiegarlo ("allora?", "com'era quella cosa?", "fatto?"), cercalo prima negli ultimi scambi, poi in CONTINUITÀ e nella memoria; se manca, chiedi recall del cassetto giusto.

MEMORIA A MODULI
- Quando l'utente ti dice qualcosa che servirà in futuro (preferenze, persone, scadenze, decisioni, dati di un progetto o di un'attività) salvalo con l'azione remember.
- Scegli un modulo esistente se è adatto, altrimenti creane uno nuovo con un nome breve (es. "lavoro", "auto", "viaggio-giappone"). I fatti stabili sulla persona vanno in "generale".
- Un ricordo = una frase autosufficiente. Non salvare ciò che è già nel diario dieta o nei promemoria.

COMPITI LUNGHI
- Se la richiesta richiede più passaggi (un piano settimanale, una ricerca, un documento di studio) avviala in background con start_job e di' che avviserai a lavoro finito.
- Non dire MAI "in background", "ti avviso appena pronto" o "sto elaborando" senza start_job nelle actions. Se hai davanti una foto, un video o un file, analizzalo SUBITO in questa risposta.
- Non inventare moduli, sistemi o tecnologie che non esistono (es. "attivo il modulo X", "uso YOLOv8"): descrivi solo quello che fai davvero.

ONESTÀ SULLE AZIONI: una cosa è fatta SOLO se la sua azione è nel campo "actions" di questa risposta. Non dire mai "ho registrato", "ho aggiornato", "ho salvato", "chiamo", "fatto" se l'azione corrispondente non c'è: se ti manca un dato per farla, chiedilo.

FORMATO DI RISPOSTA: rispondi SOLO con un oggetto JSON valido, senza testo prima o dopo:
{"reply": "testo da leggere ad alta voce", "expect_reply": true|false, "card": "riassunto schematico dei numeri o stringa vuota", "topics": [{"area": "...", "topic": "...", "parent": "..."}], "actions": [ ... ]}
- expect_reply: true se ti aspetti che l'utente continui; false se la richiesta è chiusa, se saluta o dice "basta", "grazie", "a posto".
- topics: gli argomenti di questo scambio, per la mappa della tua mente. NON aspettare MAI che l'utente ti dica "aggiungi", "salva" o "crea un nodo": a ogni messaggio che parla di un argomento, di un progetto, di uno studio, di un'app o di un'attività DEVI compilare "topics" in automatico (da 1 a 3 voci), così nuovi nodi si generano da soli nel grafo della mente.
  REGOLE LOGISTICHE E DI ANNIDAMENTO DEI NODI:
  1) "area": usa SEMPRE macro-dipartimenti stabili e ordinati (es. "lavoro", "studio", "programmazione", "intrattenimento", "tecnologia", "salute", "auto", "viaggi"), mai nomi usa-e-getta.
  2) "topic": DEVE essere un titolo concettuale breve e pulito (1-3 parole, es. "Tagliando 15.000 km", "Vasco Rossi", "Ereditarietà"), MAI una frase intera o un comando discorsivo.
  3) "parent": compila SEMPRE "parent" quando l'argomento appartiene a un contenitore/categoria più generale dentro quel ramo (es. area "intrattenimento", topic "Vasco Rossi", parent "Joytify"; area "auto", topic "Tagliando", parent "Panda"; area "programmazione", topic "Polimorfismo", parent "Programmazione a oggetti"). Riusa SEMPRE gli argomenti già presenti in ARGOMENTI GIÀ NELLA MAPPA.
- card: solo dati schematici da mostrare a schermo (es. "Pranzo: 520 kcal (P38 C45 G12) • Rimanenti: 680 kcal"); vuota se non servono.

AZIONI DISPONIBILI (campo "type"):
- add_meal {date, meal: colazione|pranzo|cena|spuntino, description, items:[{name, grams, kcal, protein, carbs, fat}]}
- update_meal {id, ...campi da cambiare} · delete_meal {id}
- add_activity {date, activity_type, description, duration_min, kcal_burned} · delete_activity {id}
- add_weight {date, kg} · set_steps {date, steps} · request_photo {reason}
- update_profile {field: targetWeightKg|goal|weeklyChangeKg|activityLevel|foodLikes|foodDislikes|dietNotes|heightCm|name, value}
- add_pantry_item {name, quantity, category} · remove_pantry_item {id | name}
- update_recipe_session {title, current_step, ingredients_needed, notes} · clear_recipe_session {}
- save_recipe {title, items, instructions, total_kcal, total_protein, total_carbs, total_fat} · delete_recipe {id | title}
- remember {module, text, description: descrizione del modulo se è nuovo} · forget {id}
- learn {rule}: quando il Capo ti corregge o ti spiega come preferisce una cosa, scrivi una regola generale e breve per non ripetere l'errore (es. "Per la musica il Capo usa Joytify, non Spotify"). Va insieme alla risposta corretta.
- clean_graph {branch: "dieta"|"sport"|"all"|nome_modulo, max_nodes: 3..10}: riduce, pulisce e riordina i nodi di un ramo del grafo (o di tutto il grafo) quando l'utente dice che un ramo è troppo grande o chiede di sistemarlo/ridurlo.
- add_reminder {text, due: "yyyy-MM-ddTHH:mm" (la prima volta), repeat: ""|giorno|feriali|settimana|mese} · done_reminder {id} (per un promemoria che si ripete lo ferma per sempre)
- add_reminder legato a un luogo {text, place: "casa"|"palestra"|..., when: arrivo|uscita, repeat: ""|sempre} (senza due). Se il luogo non è tra i LUOGHI SALVATI crealo lo stesso e chiedi all'utente di dirti "salva questo posto come <nome>" quando si trova lì.
- save_place {name}: il telefono salva la posizione in cui si trova ADESSO con quel nome · forget_place {name}
- start_job {title, goal: descrizione completa e autosufficiente del lavoro da svolgere}
- code_change {request} · code_approve {id} · code_discard {id}
- ui_pin {widget, where} · ui_unpin {widget | id, where} · ui_note {text, title, where} · ui_reset {}
- live_card {op: "set"|"remove"|"bump", id, kind: "countdown"|"stopwatch"|"progress"|"counter"|"metric"|"checklist", title, subtitle, seconds, value, max, unit, items: [{label, done}], badge}: crea o aggiorna una SCHEDA VIVA MODULARE visibile in tempo reale sullo schermo (es. timer, cronometro, contatore acqua/ripetizioni, barra avanzamento, checklist interattiva, monitor personalizzato). Scegli autonomamente il "kind" più adatto a ciò che l'utente chiede di tenere d'occhio o misurare.
- show {kind, title, items, unit, text, svg, url, seconds}: mostra una grafica animata a schermo, anche sopra le altre app se il telefono è in uso. kind: "bars" (confronti), "line" (andamento nel tempo), "pie" (proporzioni), "list" (passi, classifiche), "text" (un numero o una frase in grande), "svg" (un disegno o un'animazione: SVG completo con <animate> o <animateTransform>, colori verde #39ff14 e azzurro #22d3ee su sfondo scuro, viewBox 0 0 300 200, niente script), "image" (url https di un'immagine). items: [{label, value}] (value numerico, facoltativo per list). Usala quando un grafico o un disegno aiuta (calorie della settimana, peso, macro, risultati di una ricerca, spiegazioni visive) o quando l'utente chiede di mostrare, disegnare o animare qualcosa. La voce non legge la grafica: nella reply dì solo la sintesi.
- recall {module?, query?}: se per rispondere bene ti serve un cassetto di memoria che non vedi in MEMORIA RILEVANTE (guarda MODULI DI MEMORIA ESISTENTI), chiedilo per nome o con una frase: ti verranno dati quei ricordi e risponderai di nuovo. Usala quando la frase può toccare più aree della vita del Capo (es. stanchezza → palestra, sonno, studio).
- web_search {query}: cerca su internet (Google). Usala per notizie, fatti recenti, prezzi, orari, risultati sportivi, uscite, o qualunque cosa che potresti non sapere o che può essere cambiata. Ti verranno dati i risultati e risponderai di nuovo. Non dire MAI che non hai accesso a internet.
- read_url {url}: leggi il testo di una pagina web https.
${ACCOUNT_ACTIONS_PROMPT}
- call {name: nome del contatto in rubrica, oppure un numero}: telefonata normale. Usala SOLO quando l'utente chiede esplicitamente di chiamare qualcuno (non per WhatsApp o altre app: lì serve phone_task).
- open_app {name: nome dell'app come compare sul telefono, es. "Spotify", "Maps", "WhatsApp"} · open_url {url: indirizzo https completo}
  Usale solo quando l'utente chiede SOLO di aprire qualcosa sul telefono, senza fare altro dentro.
- pc_action {kind: "open_app"|"open_url"|"system"|"notify", target: "nome programma o URL o comando (lock|play_pause|vol_up|vol_down)"}: esegue un'azione direttamente sul PC Desktop dell'utente quando chiede di fare qualcosa sul computer/PC.
- phone_task {goal: obiettivo completo e autosufficiente, es. "Apri WhatsApp, chat con Marco, scrivi 'arrivo tra 10 minuti' e invialo"}: usi il telefono come lui (tocchi, scrivi, scorri, leggi lo schermo) finché l'obiettivo è raggiunto. Usalo SEMPRE quando chiede di fare qualcosa DENTRO un'app (mandare o leggere messaggi, cercare, mettere una canzone, impostare): apre l'app da solo, quindi non aggiungere open_app. Nel goal scrivi il nome esatto dell'app. Non dire mai "lo faccio", "apro", "mando" senza mettere davvero l'azione: se prometti un'azione sul telefono, phone_task deve esserci. Se nel goal c'è un invio o un pagamento scrivi esattamente cosa ha chiesto l'utente: prima di azioni irreversibili non richieste ti fermerai a chiedere conferma.
Le date nelle azioni sono sempre yyyy-MM-dd.`;

/**
 * Riempie il contesto entro il budget del modello.
 * parts: { core, brief, rules, blocks:[{prio,text}], memories:[string], moduleIndex, agenda, weather, summary, history:[{role,text}], userText, image }
 */
export function buildMessages(model, parts) {
  const budget = Math.max(1500, Math.min(model.ctx * 0.55, 48000));
  let used = 0;
  const take = (text) => { const t = estimateTokens(text); if (!text || used + t > budget) return false; used += t; return true; };
  // Resoconto di cosa entra nel contesto (vista Mente): nome della sezione e token stimati.
  const report = { model: model.model ? `${model.provider}:${model.model}` : '', budget: Math.round(budget), sections: [], dropped: [] };
  const note = (name, text) => report.sections.push({ name, tokens: estimateTokens(text) });

  const sections = [];
  take(parts.core); sections.push(parts.core); note('Nucleo e istruzioni', parts.core);
  used += estimateTokens(parts.userText) + (parts.image ? 800 : 0);
  if (parts.brief) { if (take(parts.brief)) { sections.push(parts.brief); note('Profilo e bilancio del giorno', parts.brief); } else report.dropped.push('Profilo'); }
  if (parts.continuity) { if (take(parts.continuity)) { sections.push(parts.continuity); note('Continuità tra le chat', parts.continuity); } else report.dropped.push('Continuità'); }
  if (parts.summary) { if (take(parts.summary)) { sections.push('RIASSUNTO DELLA CONVERSAZIONE FINORA\n' + parts.summary); note('Riassunto della conversazione', parts.summary); } else report.dropped.push('Riassunto'); }

  // Ultimi scambi: prima i 6 più recenti (indispensabili), il resto dopo se c'è spazio.
  const hist = parts.history || [];
  const kept = [];
  let idx = hist.length - 1;
  for (; idx >= Math.max(0, hist.length - 6); idx--) { if (!take(hist[idx].text)) break; kept.unshift(hist[idx]); }

  if (parts.memories?.length) {
    const lines = [];
    for (const m of parts.memories) { if (!take(m)) break; lines.push(m); }
    if (lines.length) { sections.push('MEMORIA RILEVANTE\n' + lines.join('\n')); note(`Ricordi pertinenti (${lines.length})`, lines.join('\n')); }
    report.memories = lines.map(l => l.slice(0, 140));
  }
  if (parts.rules) { if (take(parts.rules)) { sections.push(parts.rules); note('Regole del momento', parts.rules); } else report.dropped.push('Regole'); }
  const blocks = [...(parts.blocks || [])].sort((a, b) => a.prio - b.prio);
  const blockName = (b) => { const x = b.name || String(b.text).split('\n')[0].replace(/[:=]+$/, '').trim().slice(0, 50); return x === x.toUpperCase() ? x.charAt(0) + x.slice(1).toLowerCase() : x; };
  const rest = [];
  for (const b of blocks) {
    if (b.prio === 1) { if (take(b.text)) { sections.push(b.text); note(blockName(b), b.text); } else report.dropped.push(blockName(b)); }
    else rest.push(b);
  }
  const opt = (name, text, title = name) => { if (!text) return; if (take(text)) { sections.push(text); note(title, text); } else report.dropped.push(title); };
  opt('web', parts.web, 'Ricerca sul web');
  opt('accounts', parts.accounts, 'Posta, agende e documenti');
  opt('weather', parts.weather, 'Meteo');
  opt('agenda', parts.agenda, 'Agenda');
  opt('moduleIndex', parts.moduleIndex, 'Indice dei moduli di memoria');
  for (; idx >= Math.max(0, hist.length - 14); idx--) { if (!take(hist[idx].text)) break; kept.unshift(hist[idx]); }
  for (const b of rest) { if (take(b.text)) { sections.push(b.text); note(blockName(b), b.text); } else report.dropped.push(blockName(b)); }
  report.history = kept.length;
  report.used = Math.round(used);
  if (parts.report && typeof parts.report === 'object') Object.assign(parts.report, report);

  // Ruoli alternati, si parte sempre da un messaggio dell'utente.
  const turns = [];
  for (const h of kept) {
    const role = h.role === 'user' ? 'user' : 'assistant';
    if (turns.length && turns[turns.length - 1].role === role) turns[turns.length - 1].content += '\n' + h.text;
    else turns.push({ role, content: h.text });
  }
  while (turns.length && turns[0].role !== 'user') turns.shift();
  if (turns.length && turns[turns.length - 1].role === 'user') {
    // L'ultimo turno deve essere quello nuovo: accoda il messaggio corrente al precedente dell'utente.
    parts = { ...parts, userText: turns.pop().content + '\n' + parts.userText };
  }
  const mediaParts = [];
  if (parts.image) mediaParts.push({ type: 'image_url', image_url: { url: `data:image/jpeg;base64,${parts.image}` } });
  if (parts.pdfBase64) mediaParts.push({ type: 'image_url', image_url: { url: `data:application/pdf;base64,${parts.pdfBase64}` } });
  const user = mediaParts.length
    ? { role: 'user', content: [{ type: 'text', text: parts.userText }, ...mediaParts] }
    : { role: 'user', content: parts.userText };
  return [{ role: 'system', content: sections.join('\n\n') }, ...turns, user];
}

/** Da un JSON interrotto estrae "reply" e gli oggetti completi di "actions". Ritorna null se non c'è "reply". */
function salvage(text) {
  const m = /"reply"\s*:\s*"((?:[^"\\]|\\.)*)("?)/.exec(text);
  if (!m) return null;
  let reply = m[1];
  try { reply = JSON.parse('"' + m[1].replace(/\\$/, '') + '"'); } catch { /* resta com'è */ }
  const actions = [];
  const at = text.search(/"actions"\s*:\s*\[/);
  if (at >= 0) {
    let depth = 0, start = -1, inStr = false, esc = false;
    for (let i = text.indexOf('[', at) + 1; i < text.length; i++) {
      const c = text[i];
      if (inStr) { if (esc) esc = false; else if (c === '\\') esc = true; else if (c === '"') inStr = false; continue; }
      if (c === '"') inStr = true;
      else if (c === '{') { if (depth++ === 0) start = i; }
      else if (c === '}') { if (--depth === 0 && start >= 0) { try { const o = JSON.parse(text.slice(start, i + 1)); if (o && typeof o.type === 'string') actions.push(o); } catch { /* scartata */ } start = -1; } }
      else if (c === ']' && depth === 0) break;
    }
  }
  return { reply: String(reply).trim(), actions };
}

/** Estrae l'oggetto JSON della risposta anche se il modello aggiunge testo o blocchi di codice. */
export function parseReply(raw) {
  const text = String(raw || '').trim();
  const tryParse = (s) => { try { const o = JSON.parse(s); return o && typeof o === 'object' && !Array.isArray(o) ? o : null; } catch { return null; } };
  let obj = tryParse(text);
  if (!obj) {
    const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
    if (fenced) obj = tryParse(fenced[1].trim());
  }
  if (!obj) {
    const a = text.indexOf('{'), b = text.lastIndexOf('}');
    if (a >= 0 && b > a) obj = tryParse(text.slice(a, b + 1));
  }
  if (!obj || typeof obj.reply !== 'string') {
    // JSON tagliato a metà (risposta troppo lunga): recupera la frase e le azioni arrivate intere.
    const cut = salvage(text);
    if (cut) return { reply: cut.reply || 'Fatto.', expectReply: false, card: '', actions: cut.actions, topics: [], parsed: true, truncated: true };
    // Nessun JSON valido: usa il testo così com'è, senza azioni.
    const plain = text.replace(/```[\s\S]*?```/g, '').trim();
    return { reply: plain || 'Non ho capito, può ripetere?', expectReply: true, card: '', actions: [], topics: [], parsed: false };
  }
  return {
    reply: obj.reply.trim() || 'Fatto.',
    expectReply: obj.expect_reply === true || /\?\s*$/.test(obj.reply.trim()),
    card: typeof obj.card === 'string' ? obj.card.trim() : '',
    actions: Array.isArray(obj.actions) ? obj.actions.filter(a => a && typeof a.type === 'string') : [],
    mood: obj.mood && typeof obj.mood === 'object' && typeof obj.mood.emozione === 'string' ? { emozione: obj.mood.emozione.slice(0, 30), intensita: Number(obj.mood.intensita) || 0.4 } : null,
    topics: Array.isArray(obj.topics) ? obj.topics.filter(t => t && typeof t.area === 'string' && t.area.trim()).slice(0, 3).map(t => ({ area: t.area.trim().slice(0, 40), topic: String(t.topic || '').trim().slice(0, 60), parent: String(t.parent || '').trim().slice(0, 60) })) : [],
    parsed: true,
  };
}
