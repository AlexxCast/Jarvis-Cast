// Inoltro delle richieste dal Worker al Durable Object, con un motivo leggibile quando l'oggetto non risponde.

/**
 * Passa la richiesta al Durable Object. Se l'oggetto si blocca (riavvio dopo un aggiornamento, limite di CPU o
 * di memoria, errore all'avvio) Cloudflare restituisce una pagina 500 senza spiegazioni e l'app mostrava solo
 * "Errore 500". Qui si riprova una volta per gli errori passeggeri e altrimenti si risponde con il motivo vero.
 */
export async function forwardToBrain(env, request) {
  const stub = () => env.JARVIS.get(env.JARVIS.idFromName('main'));
  const retryable = request.method === 'GET' || request.method === 'HEAD';
  const spare = retryable ? null : request.clone();
  try {
    return await stub().fetch(request);
  } catch (e) {
    const msg = String(e?.message || e || 'errore sconosciuto');
    console.error('Durable Object non raggiungibile:', msg);
    if (e?.retryable || /reset|code was updated|restart|disconnected|network connection lost/i.test(msg)) {
      try { return await stub().fetch(retryable ? request : spare); } catch (e2) { return brainDown(String(e2?.message || e2)); }
    }
    return brainDown(msg);
  }
}

function brainDown(msg) {
  return Response.json({ error: `Kestra non risponde in questo momento (${msg.slice(0, 200)}). Riprova tra qualche secondo.` }, { status: 503 });
}
