const $ = (id) => document.getElementById(id);
// CONFIGURAÇÃO DA DERIV
const APP_ID = 1089;
const WS_URL = `wss://ws.derivws.com/websockets/v3?app_id=${APP_ID}`;
let accountType = "demo"; 
let ws = null, 
  reqId = 0,
  pendingReqs = {},
  handlers = {}; 

let optionsPingTimer = null;
let optionsPingReqId = 900000;
// Pedidos de negociação da Options API
let optionsRequestId = 500000;
let pendingOptionsRequests = {};
// Registo de compras enviadas sem confirmação imediata
let pendingBuyReconciliations = {};
// Acompanhamento de contratos pela Options API
let activeContractMonitors = {};
// C1 — Contexto privado das propostas Options API
const proposalContexts = new WeakMap();

let ticks = [],
  selectedDigit = 0;

let animatedBars = Array(10).fill(0);
let animatedPcts = Array(10).fill(0);

let activeTickSubscriptionId = null;
let activeTickSymbol = null;
let pendingSymbolChange = null;

// Controlo das operações de subscrição
let subscriptionReqId = 3000;
let pendingSubscriptionRequests = {};
let symbolChangeInProgress = false;

// Limpar apenas os pedidos pertencentes ao socket que fechou
function cleanupPendingRequestsForSocket(socket) {
  let optionsCleaned = 0;
  let subscriptionsCleaned = 0;

  // Limpar pedidos da Options API e rejeitar as respectivas Promises
  Object.entries(pendingOptionsRequests).forEach(function ([id, request]) {
    if (request.socket === socket) {
      clearTimeout(request.timer);
      delete pendingOptionsRequests[id];

            const closeError = new Error(
        request.isBuy && request.sent
          ? "UNKNOWN: ligação fechada durante a confirmação da compra."
          : "Ligação WebSocket fechada antes da resposta."
      );

      if (request.isBuy && request.sent) {
        closeError.code = "BUY_UNKNOWN";
      }

      request.reject(closeError);

      optionsCleaned++;
    }
  });

  // Limpar pedidos de subscrição pertencentes ao mesmo socket
  Object.entries(pendingSubscriptionRequests).forEach(function ([id, request]) {
    if (request.socket === socket) {
      delete pendingSubscriptionRequests[id];
      subscriptionsCleaned++;
    }
  });

  console.log("TradeProJB: Limpeza após fecho do WebSocket:", {
    pedidosOptionsAPI: optionsCleaned,
    pedidosSubscricao: subscriptionsCleaned
  });
}
const app = {
  status: "idle",
  token: null,
  wsReady: false,
  connectedAccountType: null,
  connectedAccountId: null,
  lastPurchaseAttempt: null,
  purchaseInProgress: false
};
// CONTAS DERIV
let derivAccounts = [];
let selectedAccountId = null;

const bot = {
  running: false,
  initialStake: 0.35,
  stopLoss: 10,
  takeProfit: 50,
  dailyTarget: 100,
  symbol: "R_10",
  duration: 1,
  durationType: "t",
  prediction: 0,
  currentStake: 0.35,
  contractType: "DIGITDIFF",
  totalProfit: 0,
  totalTrades: 0,
  wins: 0,
  losses: 0,
  accLoss: 0,
  isRecovery: false,
  recoveryIdx: 0,
  balance: 0,
  history: [],
  manipulationDetected: false,
  skippedTrades: 0
};
const recoveryContracts = [
  "DIGITOVER",
  "DIGITUNDER",
  "DIGITEVEN",
  "DIGITODD",
  "CALL",
  "PUT"
];

// ==================== ANTI-MANIPULATION ====================
const antiManip = {
  digitHistory: [],
  windowSize: 20,
  maxRepeat: 3,
  maxFreqPct: 0.45,
  cooldownTrades: 0,
  cooldownDuration: 3,

  pushDigit(digit) {
  const lastDigit = Number(digit);

  if (!Number.isInteger(lastDigit) || lastDigit < 0 || lastDigit > 9) {
    return;
  }

  this.digitHistory.push(lastDigit);

  if (this.digitHistory.length > this.windowSize * 2) {
    this.digitHistory = this.digitHistory.slice(-this.windowSize);
  }
},

  isSuspicious() {
    if (this.digitHistory.length < this.windowSize)
      return { suspicious: false, reason: "" };
    const w = this.digitHistory.slice(-this.windowSize);

    let consec = 1;
    for (let i = w.length - 1; i > 0; i--) {
      if (w[i] === w[i - 1]) {
        consec++;
        if (consec >= this.maxRepeat)
          return {
            suspicious: true,
            reason: "Dígito " + w[i] + " repetiu " + consec + "x seguidas"
          };
      } else break;
    }

    const freq = {};
    w.forEach((d) => (freq[d] = (freq[d] || 0) + 1));
    for (const [digit, count] of Object.entries(freq)) {
      const pct = count / w.length;
      if (pct > this.maxFreqPct)
        return {
          suspicious: true,
          reason:
            "Dígito " +
            digit +
            " apareceu " +
            (pct * 100).toFixed(0) +
            "% das vezes"
        };
    }

    if (w.length >= 6) {
      const l = w.slice(-6);
      if (
        l[0] === l[2] &&
        l[2] === l[4] &&
        l[1] === l[3] &&
        l[3] === l[5] &&
        l[0] !== l[1]
      ) {
        return {
          suspicious: true,
          reason: "Padrão alternado " + l[0] + "↔" + l[1] + " detectado"
        };
      }
    }

    return { suspicious: false, reason: "" };
  },

  shouldSkip() {
    if (this.cooldownTrades > 0) {
      this.cooldownTrades--;
      return {
        skip: true,
        reason: "Cooldown: aguardando " + (this.cooldownTrades + 1) + " ticks"
      };
    }
    const check = this.isSuspicious();
    if (check.suspicious) {
      this.cooldownTrades = this.cooldownDuration;
      return { skip: true, reason: check.reason };
    }
    return { skip: false, reason: "" };
  }
};

//=============== SEPARADOR CONEXÃO
function setAppStatus(s) {
  app.status = s;
  console.log("STATUS:", s);
}
// ==================== INIT DIGITS ====================
function initDigits() {
  const g = $("digitGrid");
  if (!g) return;
  g.innerHTML = "";
  for (let i = 0; i < 10; i++) {
    const b = document.createElement("button");
    b.className = "digit-btn" + (i === 0 ? " active" : "");
    b.textContent = i;
    b.onclick = function () {
      if (bot.running) return;
      selectedDigit = i;
      document.querySelectorAll(".digit-btn").forEach(function (d) {
        d.classList.remove("active");
      });
      b.classList.add("active");
    };
    g.appendChild(b);
  }
}


function setAccountType(t, preserveSelection = false) {
  t = String(t).toLowerCase();

  if (t !== "demo" && t !== "real") {
    console.warn("TradeProJB: Tipo de conta inválido:", t);
    return;
  }

  accountType = t;

  // Actualizar os botões Demo e Real do dashboard
  const btnDemo = $("btnDemo");
  const btnReal = $("btnReal");
  const realWarning = $("realWarning");

  if (btnDemo) {
    btnDemo.className =
      "account-btn" + (t === "demo" ? " active" : "");
  }

  if (btnReal) {
    btnReal.className =
      "account-btn" + (t === "real" ? " active" : "");
  }

  if (realWarning) {
    realWarning.classList.toggle("hidden", t !== "real");
  }

  // Preservar a conta escolhida manualmente no selector
  if (preserveSelection) {
    return;
  }

  // Procurar uma conta activa do tipo seleccionado
  const account = derivAccounts.find(function (item) {
    return (
      String(item.account_type).toLowerCase() === t &&
      String(item.status).toLowerCase() === "active"
    );
  });

  if (account) {
    selectedAccountId = String(account.account_id);

    const select = $("accountSelect");

    if (select) {
      select.value = selectedAccountId;
    }

    console.log("TradeProJB: Tipo de conta seleccionado:", {
      tipo: accountType,
      conta: selectedAccountId
    });
  } else {
    selectedAccountId = null;

    const select = $("accountSelect");

    if (select) {
      select.value = "";
    }

    console.warn(
      "TradeProJB: Nenhuma conta activa encontrada para:",
      t
    );
  }
}
// ==================== WS ====================
function wsSend(payload) {
  return new Promise(function (resolve, reject) {
    if (!ws || ws.readyState !== 1) return reject("WS não conectado");
    var id = ++reqId;
    pendingReqs[id] = { resolve: resolve, reject: reject };
    ws.send(JSON.stringify(Object.assign({}, payload, { req_id: id })));
    setTimeout(function () {
      if (pendingReqs[id]) {
        delete pendingReqs[id];
        reject("Timeout");
      }
    }, 30000);
  });
}

//================== CONNECT WS ====================
function connectWS(token) {
  return new Promise(function (resolve, reject) {
    ws = new WebSocket(WS_URL);
    ws.onopen = function () {
      wsSend({ authorize: token })
        .then(function (d) {
          if (d.error) return reject(d.error.message);
          resolve(d.authorize);
        })
        .catch(reject);
    };
    ws.onmessage = function (e) {
      var d = JSON.parse(e.data);
      if (d.req_id && pendingReqs[d.req_id]) {
        pendingReqs[d.req_id].resolve(d);
        delete pendingReqs[d.req_id];
      }
      if (d.msg_type === "tick" && d.tick) {
        ticks.push(d.tick);
        if (ticks.length > 100) ticks.shift();

        //************GRÁFICO DE BARRAS***************
        const pipSize = Number(d.tick.pip_size);
const formattedQuote = Math.abs(Number(d.tick.quote)).toFixed(pipSize);
const digit = Number(
  formattedQuote.charAt(formattedQuote.length - 1)
);

antiManip.pushDigit(digit);
        $("chartPrice").textContent = d.tick.quote.toFixed(4);
      }
      if (d.msg_type === "balance" && d.balance) {
        bot.balance = parseFloat(d.balance.balance);
        $("headerBalance").innerHTML =
          bot.balance.toFixed(2) + " <small>USD</small>";
      }
      if (d.msg_type === "proposal_open_contract") {
        var c = d.proposal_open_contract;
        if (c && c.is_sold && handlers.sold) handlers.sold(c);
      }
    };
    ws.onerror = function () {
      reject("Erro de conexão");
    };
  });
}

// ============================================================
// TRADEPROJB — DERIV OAUTH 2.0 + PKCE
// ============================================================

const DERIV_CLIENT_ID = "34QF0EDN9wbRFeKn7UuDs";

const DERIV_REDIRECT_URI =
  "https://matenge92.github.io/Deriv-ProV/";

const BACKEND_URL =
  "https://tradeprojb-backend.baptistajuniormatenge.workers.dev";

// Codificação Base64 URL-safe
function base64UrlEncode(bytes) {
  let binary = "";

  bytes.forEach(function (byte) {
    binary += String.fromCharCode(byte);
  });

  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

// Gerar valores aleatórios seguros
function randomBase64Url(byteLength) {
  const bytes = crypto.getRandomValues(
    new Uint8Array(byteLength)
  );

  return base64UrlEncode(bytes);
}

// Gerar SHA-256 para PKCE
async function sha256Base64Url(value) {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value)
  );

  return base64UrlEncode(new Uint8Array(digest));
}

// Iniciar login Deriv
async function loginWithDeriv() {
  try {
    const verifier = randomBase64Url(32);
    const state = randomBase64Url(16);

    const challenge = await sha256Base64Url(verifier);

    sessionStorage.setItem(
      "tradeprojb_pkce_verifier",
      verifier
    );

    sessionStorage.setItem(
      "tradeprojb_oauth_state",
      state
    );

    const params = new URLSearchParams({
      response_type: "code",
      client_id: DERIV_CLIENT_ID,
      redirect_uri: DERIV_REDIRECT_URI,
      scope: "trade account_manage",
      state: state,
      code_challenge: challenge,
      code_challenge_method: "S256"
    });

    window.location.assign(
      "https://auth.deriv.com/oauth2/auth?" +
      params.toString()
    );

  } catch (error) {
    console.error("Erro ao iniciar OAuth:", error);
    alert("Não foi possível iniciar o login da Deriv.");
  }
}

// Processar retorno da autenticação
async function handleDerivOAuthCallback() {
  const params = new URLSearchParams(
    window.location.search
  );

  const code = params.get("code");
  const returnedState = params.get("state");
  const oauthError = params.get("error");

  if (oauthError) {
    window.history.replaceState(
      {},
      document.title,
      window.location.pathname
    );

    throw new Error(
      "A Deriv devolveu um erro: " + oauthError
    );
  }

  if (!code) return;

  const savedState = sessionStorage.getItem(
    "tradeprojb_oauth_state"
  );

  const verifier = sessionStorage.getItem(
    "tradeprojb_pkce_verifier"
  );

  window.history.replaceState(
    {},
    document.title,
    window.location.pathname
  );

  if (
    !savedState ||
    returnedState !== savedState ||
    !verifier
  ) {
    throw new Error(
      "Validação OAuth falhou. Estado inválido ou sessão expirada."
    );
  }

  try {
    const response = await fetch(
      BACKEND_URL + "/oauth/token",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          code: code,
          code_verifier: verifier
        })
      }
    );

    const data = await response.json();

    if (
      !response.ok ||
      !data.success ||
      !data.access_token
    ) {
      throw new Error(
        data.error_description ||
        data.message ||
        "Falha na autenticação."
      );
    }

    // Guardar o token apenas na memória    
      app.token = data.access_token;

    // Carregar as contas Deriv
      await loadDerivAccounts();

// Mostrar o Dashboard após carregar as contas
$("loginScreen").classList.add("hidden");
$("dashboard").classList.remove("hidden");
    
    console.log(
      "TradeProJB: OAuth autorizado com sucesso."
    );

    console.log(
      "Token válido por:",
      data.expires_in,
      "segundos"
    );

  } finally {
    sessionStorage.removeItem(
      "tradeprojb_pkce_verifier"
    );

    sessionStorage.removeItem(
      "tradeprojb_oauth_state"
    );
  }
}
// ==================== CARREGAR CONTAS DERIV ====================

async function loadDerivAccounts() {
  const select = $("accountSelect");
  const connectButton = $("btnConnectAccount");

  if (!app.token) {
    throw new Error("Token OAuth não disponível.");
  }

  if (!select) {
    throw new Error("Selector accountSelect não encontrado no HTML.");
  }

  select.disabled = true;
  select.innerHTML = '<option value="">A carregar contas...</option>';

  if (connectButton) connectButton.disabled = true;

  try {
    const response = await fetch(BACKEND_URL + "/accounts", {
      method: "GET",
      headers: {
        "Authorization": "Bearer " + app.token
      }
    });

    const result = await response.json();

    if (!response.ok || !result.success) {
      throw new Error(
        result.message || result.error || "Não foi possível carregar as contas."
      );
    }

    derivAccounts = Array.isArray(result.data) ? result.data : [];

    // Mostrar apenas contas activas
    const activeAccounts = derivAccounts.filter(function (account) {
      return String(account.status).toLowerCase() === "active";
    });

    select.innerHTML = "";

    if (activeAccounts.length === 0) {
      select.innerHTML =
        '<option value="">Nenhuma conta activa encontrada</option>';

      throw new Error("A Deriv não devolveu contas activas.");
    }

    activeAccounts.forEach(function (account) {
      const option = document.createElement("option");

      option.value = account.account_id;

      const type = String(account.account_type || "").toLowerCase();
      const labelType = type === "demo" ? "DEMO" : "REAL";

      const balance = Number(account.balance || 0).toFixed(2);
      const currency = account.currency || "USD";

      option.textContent =
        labelType + " | " +
        account.account_id + " | " +
        balance + " " + currency;

      select.appendChild(option);
    });

    // Seleccionar a conta correspondente ao modo actual
    let selectedAccount = activeAccounts.find(function (account) {
      return String(account.account_type).toLowerCase() === accountType;
    });

    if (!selectedAccount) {
      selectedAccount = activeAccounts[0];
    }

    select.value = selectedAccount.account_id;
    selectedAccountId = selectedAccount.account_id;

    select.disabled = false;
    if (connectButton) connectButton.disabled = false;

    // Actualizar a selecção quando o utilizador escolher outra conta
    select.onchange = function () {
  const chosenAccountId = select.value;

  const account = derivAccounts.find(function (item) {
    return String(item.account_id) === String(chosenAccountId);
  });

  if (account) {
    setAccountType(
  String(account.account_type).toLowerCase(),
  true
);

    // Restaurar a conta que o utilizador escolheu
    selectedAccountId = chosenAccountId;
    select.value = chosenAccountId;
  }
};
    console.log(
      "TradeProJB: Contas carregadas:",
      activeAccounts.length
    );

    console.log(
      "TradeProJB: Conta seleccionada:",
      selectedAccountId
    );

  } catch (error) {
    select.innerHTML =
      '<option value="">Erro ao carregar contas</option>';

    select.disabled = true;

    console.error("Erro ao carregar contas Deriv:", error);
    throw error;
  }
}

// ==================== LIGAÇÃO OPTIONS API (OTP) ====================
// Esta função apenas autentica a ligação WebSocket.
// Ainda NÃO envia propostas nem executa compras.
async function connectSelectedAccount() {
  const button = $("btnConnectAccount");

  if (!app.token) {
    alert("Faça primeiro o login com a Deriv.");
    return;
  }

  if (!selectedAccountId) {
    alert("Seleccione uma conta Deriv.");
    return;
  }

  const account = derivAccounts.find(function (item) {
    return String(item.account_id) === String(selectedAccountId);
  });

  if (!account || String(account.status).toLowerCase() !== "active") {
    alert("A conta seleccionada não está activa.");
    return;
  }

  const selectedType = String(account.account_type || "").toLowerCase();
  
  const requestedAccountId = String(account.account_id);

  // Nesta fase, permitir apenas testes Demo.
  if (selectedType !== "demo") {
    alert("Por segurança, nesta fase só podemos testar a conta DEMO.");
    return;
  }

  if (
  ws &&
  ws.readyState === WebSocket.OPEN &&
  app.wsReady &&
  app.connectedAccountType === selectedType &&
  String(app.connectedAccountId) === requestedAccountId
) {
  console.log(
    "TradeProJB: A conta seleccionada já está ligada:",
    requestedAccountId
  );
  return;
}

  if (button) {
    button.disabled = true;
    button.textContent = "A LIGAR...";
  }

  // Limpar dados da ligação anterior
ticks = [];
antiManip.digitHistory = [];
antiManip.cooldownTrades = 0;

const samplesElement = $("analysisSamples");
if (samplesElement) {
  samplesElement.textContent = "0";
}

bot.manipulationDetected = false;

  // Limpar o estado da ligação anterior
app.wsReady = false;
app.connectedAccountType = null;
app.connectedAccountId = null;
app.status = "connecting";

if (ws) {
  const previousSocket = ws;
  ws = null;

  try {
    previousSocket.close();
  } catch (_) {}
}

  try {
    // Pedir OTP ao Worker. O OTP é temporário e de utilização única.
    const response = await fetch(BACKEND_URL + "/connect", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": "Bearer " + app.token
      },
      body: JSON.stringify({
        account_id: requestedAccountId
      }),
    });

    const result = await response.json();

    if (!response.ok || !result.success ||
        !result.data || !result.data.url) {
      throw new Error(
        result.message || result.error ||
        "O Worker não conseguiu gerar o endereço de ligação."
      );
    }

    const socketUrl = result.data.url;

    // Verificação adicional: aceitar apenas WebSocket Demo da Deriv.
    const parsedUrl = new URL(socketUrl);
    if (
      parsedUrl.protocol !== "wss:" ||
      parsedUrl.hostname !== "api.derivws.com" ||
      !parsedUrl.pathname.includes("/trading/v1/options/ws/demo") ||
      !parsedUrl.searchParams.get("otp")
    ) {
      throw new Error("A Deriv devolveu um endereço WebSocket Demo inválido.");
    }

    // Ligar imediatamente: o OTP expira e só pode ser usado uma vez.
    await new Promise(function (resolve, reject) {
      let settled = false;
      const socket = new WebSocket(socketUrl);
      ws = socket;

      const connectionTimeout = setTimeout(function () {
        if (!settled) {
          settled = true;
          try { socket.close(); } catch (_) {}
          reject(new Error("Tempo esgotado ao ligar à Deriv."));
        }
      }, 20000);

      socket.onopen = function () {
        if (settled) return;
        settled = true;
        clearTimeout(connectionTimeout);

        app.wsReady = true;
        app.status = "connected";
        app.connectedAccountType = selectedType;
        app.connectedAccountId = requestedAccountId;

        console.log("TradeProJB: WebSocket Options API ligado à conta DEMO.");
        
        // Consultar instrumentos disponíveis
        socket.send(JSON.stringify({
          active_symbols: "brief",
          req_id: 1001
        }));

        console.log("TradeProJB: Pedido de instrumentos enviado.");

        // Consultar contratos do instrumento configurado
        socket.send(JSON.stringify({
          contracts_for: bot.symbol,
          req_id: 1002
        }));

        console.log("TradeProJB: Pedido de contratos enviado para:", bot.symbol);

        // Subscrever fluxo de ticks em tempo real
        socket.send(JSON.stringify({
          ticks: bot.symbol,
          subscribe: 1,
          req_id: 1003
        }));

        console.log("TradeProJB: Pedido de subscrição de ticks enviado para:", bot.symbol);
        
        // Manter a ligação Options API activa.
if (optionsPingTimer) {
  clearInterval(optionsPingTimer);
}

optionsPingTimer = setInterval(function () {
  if (socket.readyState === WebSocket.OPEN) {
    const pingId = ++optionsPingReqId;

    socket.send(JSON.stringify({
      ping: 1,
      req_id: pingId
    }));

    console.log("TradeProJB: Ping enviado:", pingId);
  }
}, 30000);
        
        if (button) {
          button.disabled = false;
          button.textContent = "CONTA DEMO LIGADA";
        }
        resolve();
      };

      
socket.onmessage = function (event) {
  let message;

  try {
    message = JSON.parse(event.data);
  } catch (error) {
    console.warn("TradeProJB: mensagem WebSocket não reconhecida.");
    return;
  }

    // Resolver pedidos da Options API
  const optionsPending = message.req_id
    ? pendingOptionsRequests[message.req_id]
    : null;

  if (optionsPending) {
    delete pendingOptionsRequests[message.req_id];

    clearTimeout(optionsPending.timer);

        if (message.error) {
      const apiError = new Error(
        message.error.message || "Erro da Options API."
      );

      apiError.code = "DERIV_REJECTED";
      apiError.deriv_error = message.error;

      optionsPending.reject(apiError);

    } else {
      optionsPending.resolve(message);
    }
    
    console.log(
      "TradeProJB: Resposta Options API recebida:",
      message.req_id,
      message.msg_type
    );
  }
  
  // Confirmar respostas dos pedidos de subscrição
  const completedRequest = message.req_id
    ? pendingSubscriptionRequests[message.req_id]
    : null;

  if (completedRequest && !message.error) {
    delete pendingSubscriptionRequests[message.req_id];

    console.log(
      "TradeProJB: Pedido confirmado:",
      completedRequest.action,
      completedRequest.symbol,
      "ID:",
      message.req_id
    );

    // Confirmar a nova subscrição de ticks.
    if (
      completedRequest.action === "subscribe" &&
      message.subscription &&
      message.subscription.id
    ) {
      activeTickSubscriptionId = message.subscription.id;
      activeTickSymbol = completedRequest.symbol;

      pendingSymbolChange = null;
      symbolChangeInProgress = false;

      console.log(
        "TradeProJB: Nova subscrição activa:",
        activeTickSymbol,
        "Subscription ID:",
        activeTickSubscriptionId
      );
    }
  }


  // 1. Confirmar resposta ao Ping
  if (message.msg_type === "ping" && message.ping === "pong") {
    console.log(
      "TradeProJB: Pong recebido:",
      message.req_id || "sem req_id"
    );
    return;
  }

  // 4. Erros da API
if (message.error) {
  const failedReqId = message.req_id;

  if (
    failedReqId &&
    pendingSubscriptionRequests[failedReqId]
  ) {
    const failedRequest =
      pendingSubscriptionRequests[failedReqId];

    delete pendingSubscriptionRequests[failedReqId];

    console.error(
      "TradeProJB: Falha na operação de subscrição:",
      failedRequest.action,
      failedRequest.symbol,
      message.error.message
    );

    if (
  failedRequest.action === "subscribe" ||
  failedRequest.action === "contracts_for" ||
  failedRequest.action === "forget"
    ) {
      pendingSymbolChange = null;
      symbolChangeInProgress = false;
    }

    alert(
      "A Deriv não aceitou a operação no índice " +
      failedRequest.symbol +
      ": " +
      message.error.message
    );

    return;
  }

  console.error(
    "TradeProJB Options API:",
    message.error.message || "Erro recebido."
  );

  return;
}

// 5. ACOMPANHAMENTO DOS CONTRATOS OPTIONS API
if (message.msg_type === "proposal_open_contract") {
  const contract = message.proposal_open_contract;

  if (contract) {
    const contractId = String(contract.contract_id);
    const monitor = activeContractMonitors[contractId];

    if (monitor) {
      // Guardar o ID da subscrição para posterior cancelamento.
      if (message.subscription?.id) {
        monitor.subscriptionId = message.subscription.id;
      }

      console.log(
        "TradeProJB: Actualização do contrato:",
        {
          contract_id: contractId,
          status: contract.status,
          profit: contract.profit,
          bid_price: contract.bid_price,
          is_sold: contract.is_sold
        }
      );

      try {
        monitor.onUpdate(contract);
      } catch (error) {
        console.error(
          "TradeProJB: Erro no processamento do contrato:",
          error
        );
      }

      // Detectar o encerramento do contrato.
      const finished = [
        "won",
        "lost",
        "sold",
        "cancelled"
      ].includes(String(contract.status).toLowerCase());

      if (finished || contract.is_sold || contract.is_expired) {
        const subscriptionId = monitor.subscriptionId;

        delete activeContractMonitors[contractId];

        console.log(
          "TradeProJB: Contrato terminado:",
          contractId
        );

        // Cancelar a subscrição quando existir.
        if (subscriptionId) {
          sendOptionsRequest({
            forget: subscriptionId
          }).then(function () {
            console.log(
              "TradeProJB: Subscrição do contrato cancelada:",
              subscriptionId
            );
          }).catch(function (error) {
            console.warn(
              "TradeProJB: Não foi possível cancelar a subscrição:",
              error.message
            );
          });
        }
      }
    }
  }

  return;
}  

  // 2. Resposta: instrumentos disponíveis
  if (message.msg_type === "active_symbols") {
    const symbols = message.active_symbols || [];

    console.log(
      "TradeProJB: Instrumentos disponíveis:",
      symbols.length
    );

    console.table(
      symbols.map(function (item) {
        return {
          símbolo: item.underlying_symbol,
          nome: item.underlying_symbol_name,
          mercado: item.market,
          aberto: item.exchange_is_open,
          suspenso: item.is_trading_suspended
        };
      })
    );
    return;
  }

  // 3. Resposta: contratos disponíveis
  if (message.msg_type === "contracts_for") {
    const contracts =
      message.contracts_for &&
      message.contracts_for.available
        ? message.contracts_for.available
        : [];
    

    console.log(
      "TradeProJB: Contratos disponíveis:",
      contracts.length,
      "para",
      message.echo_req
        ? message.echo_req.contracts_for
        : "símbolo desconhecido"
    );

    console.table(
      contracts.map(function (item) {
        return {
          contrato: item.contract_type,
          categoria: item.contract_category,
          mercado: item.market,
          duração_minima: item.min_contract_duration,
          duração_máxima: item.max_contract_duration,
          barreiras: item.barriers,
          sentimento: item.sentiment
        };
      })
    );
    return;
  }

  // 4.1. Processar ticks da Options API
if (message.msg_type === "tick" && message.tick) {

  const tick = message.tick;

  // Ignorar ticks de índices diferentes do configurado.
  if (tick.symbol !== bot.symbol) {
    return;
  }

  if (message.subscription?.id) {
  const newSubscriptionId = message.subscription.id;

  if (newSubscriptionId !== activeTickSubscriptionId) {
    activeTickSubscriptionId = newSubscriptionId;
    activeTickSymbol = tick.symbol;

    console.log(
      "TradeProJB: Subscrição activa:",
      activeTickSymbol
    );
  }
}

  const quote = Number(tick.quote);
  const pipSize = Number(tick.pip_size);

  if (
    !Number.isFinite(quote) ||
    !Number.isInteger(pipSize) ||
    pipSize < 0 ||
    pipSize > 10
  ) {
    console.warn("TradeProJB: Tick com valores inválidos.", tick);
    return;
  }

  // Calcular o último dígito respeitando as casas decimais do símbolo
  const formattedQuote = Math.abs(quote).toFixed(pipSize);
  const digit = Number(
    formattedQuote.charAt(formattedQuote.length - 1)
  );

  if (!Number.isInteger(digit) || digit < 0 || digit > 9) {
    return;
  }

  // Guardar cotação e dígito calculado
  ticks.push({
    quote,
    digit,
    epoch: tick.epoch,
    symbol: tick.symbol
  });

  if (ticks.length > 1000) {
  ticks.shift();
}
  
  // Actualizar contador de amostras em tempo real
const samplesElement = $("analysisSamples");

if (samplesElement) {
  samplesElement.textContent = getAnalysisTicks().length;
}

  // Alimentar o filtro com o mesmo dígito
  antiManip.pushDigit(digit);

  // Actualizar o preço no painel
  const priceElement = $("chartPrice");

  if (priceElement) {
    priceElement.textContent = quote.toFixed(pipSize);
  }

  return;
}
  
  // 5. Outras mensagens
  console.log(
    "TradeProJB Options API: mensagem recebida",
    message.msg_type || "sem msg_type"
  );
};

      socket.onerror = function () {
        if (!settled) {
          settled = true;
          clearTimeout(connectionTimeout);
          reject(new Error("Erro ao estabelecer WebSocket com a Deriv."));
        }
        console.error("TradeProJB: erro no WebSocket Options API.");
      };

      socket.onclose = function (event) {

  // Limpar pedidos pertencentes a esta ligação,
  // mesmo que já exista outro socket activo.
        cleanupPendingRequestsForSocket(socket);
  
        if (ws === socket) {
          if (optionsPingTimer) {
      clearInterval(optionsPingTimer);
      optionsPingTimer = null;
    }

    app.wsReady = false;
    app.connectedAccountType = null;
    app.connectedAccountId = null;

    if (app.status !== "idle") {
      app.status = "idle";
    }
  }   
        if (button) {
          button.disabled = false;
          button.textContent = "LIGAR CONTA";
        }

        console.log(
          "TradeProJB: WebSocket fechado. Código:",
          event.code
        );

        if (!settled) {
          settled = true;
          clearTimeout(connectionTimeout);
          reject(new Error("A ligação WebSocket foi fechada antes de concluir."));
        }
      };
    });

  } catch (error) {
    app.wsReady = false;
    app.status = "idle";
    app.connectedAccountType = null;
    app.connectedAccountId = null;

    console.error("TradeProJB: falha na ligação Demo:", error);
    alert("Não foi possível ligar à conta Demo: " + error.message);

    if (button) {
      button.disabled = false;
      button.textContent = "LIGAR CONTA";
    }
  }
}

// Enviar pedidos de subscrição com IDs únicos
function sendSubscriptionRequest(socket, payload, action, symbol) {
  if (!socket || socket.readyState !== WebSocket.OPEN) {
    throw new Error("WebSocket não está disponível.");
  }

  const requestId = ++subscriptionReqId;

  pendingSubscriptionRequests[requestId] = {
  action: action,
  symbol: symbol,
  createdAt: Date.now(),
  socket: socket
};
  
  socket.send(JSON.stringify({
    ...payload,
    req_id: requestId
  }));

  return requestId;
}

// ============================================================
// TRADEPROJB — SISTEMA DE PEDIDOS OPTIONS API
// ============================================================

function sendOptionsRequest(payload, timeout = 15000) {
  return new Promise(function (resolve, reject) {

    
    const accountId = String(app.connectedAccountId || "");
    const socket = ws;
    if (
      !socket ||
      socket.readyState !== WebSocket.OPEN ||
      !app.wsReady ||
      app.connectedAccountType !== "demo"
    ) {
      throw new Error(
        "Options API não está ligada à conta Demo. Compra não enviada."
      );
    }

    const isBuy = Object.prototype.hasOwnProperty.call(payload, "buy");
    const requestId = ++optionsRequestId;

        const timer = setTimeout(function () {
          const pending = pendingOptionsRequests[requestId];

          if (pending) {
            delete pendingOptionsRequests[requestId];

            const timeoutError = new Error(
              pending.isBuy && pending.sent
              ? "UNKNOWN: a compra foi enviada, mas não chegou confirmação."
              : "Tempo esgotado no pedido Options API: " + requestId
            );

            if (pending.isBuy && pending.sent) {
              timeoutError.code = "BUY_UNKNOWN";
            }

            reject(timeoutError);
          }
        }, timeout);
    
        pendingOptionsRequests[requestId] = {
          resolve: resolve,
          reject: reject,
          timer: timer,
          createdAt: Date.now(),
          payload: payload,
          socket: socket,
          isBuy: isBuy,
          sent: false
        };
    
    try {
          const message = JSON.stringify({
            ...payload,
        req_id: requestId
      });

      const pendingRequest = pendingOptionsRequests[requestId];

      socket.send(message);
      
      // Só marcar como enviada depois de socket.send aceitar a mensagem.
      pendingRequest.sent = isBuy;


      console.log(
        "TradeProJB: Pedido Options API enviado:",
        requestId,
        payload
      );

    } catch (error) {
      const pendingRequest = pendingOptionsRequests[requestId];

      clearTimeout(timer);
      delete pendingOptionsRequests[requestId];

          if (pendingRequest && pendingRequest.isBuy) {
        
            if (pendingRequest.sent) {
              const unknownError = new Error(
                "UNKNOWN: não foi possível confirmar o envio ou resultado da compra."
              );
              
              unknownError.code = "BUY_UNKNOWN";
              unknownError.cause = error;

    
              reject(unknownError);
              return;
            }

            const notSentError = new Error(
              "A compra não chegou a ser enviada."
            );

            notSentError.code = "REQUEST_NOT_SENT";
            notSentError.cause = error;

            reject(notSentError);
            return;
          }
          reject(error);
        }
  });
}
    
    async function requestContractProposal() {

  // =========================================================
  // 1. VALIDAR A LIGAÇÃO E A CONTA
  // =========================================================

  if (
    !ws ||
    ws.readyState !== WebSocket.OPEN ||
    !app.wsReady ||
    app.connectedAccountType !== "demo"
  ) {
    throw new Error(
      "A Options API não está ligada a uma conta Demo."
    );
  }

  if (
    !selectedAccountId ||
    !app.connectedAccountId ||
    String(selectedAccountId) !== String(app.connectedAccountId)
  ) {
    throw new Error(
      "A conta seleccionada não corresponde à conta ligada. " +
      "Ligue novamente a conta correcta."
    );
  }

  const connectedAccountId = String(app.connectedAccountId);

// C2 — Fixar a sessão que irá criar a proposta
 
  const socketAtRequest = ws;
  const isRecoveryAtRequest = Boolean(bot.isRecovery);

  const account = derivAccounts.find(function (item) {
   return String(item.account_id) === connectedAccountId;
 });

  if (
    !account ||
    String(account.status).toLowerCase() !== "active" ||
    String(account.account_type).toLowerCase() !== "demo" ||
    !account.currency
  ) {
    throw new Error(
      "A conta Demo ligada não foi validada correctamente."
    );
  }
  
   // C2 — Fixar a moeda da conta validada
  const currency = String(account.currency);

  // =========================================================
  // 2. VALIDAR OS PARÂMETROS DA PROPOSTA
  // =========================================================

  const contractType = String(bot.contractType || "").toUpperCase();

  const allowedContracts = [
    "DIGITDIFF",
    "DIGITOVER",
    "DIGITUNDER",
    "DIGITMATCH",
    "DIGITEVEN",
    "DIGITODD",
    "CALL",
    "PUT"
  ];

  if (!allowedContracts.includes(contractType)) {
    throw new Error(
      "Tipo de contrato não permitido: " + contractType
    );
  }

  const stake = Number(bot.currentStake);
  const duration = Number(bot.duration);
  const durationUnit = String(bot.durationType);
  const symbol = String(bot.symbol || "");

  if (!Number.isFinite(stake) || stake <= 0) {
    throw new Error("Valor de stake inválido.");
  }

  if (!Number.isInteger(duration) || duration <= 0) {
    throw new Error("Duração do contrato inválida.");
  }

  if (!["t", "s", "m", "h", "d"].includes(durationUnit)) {
    throw new Error("Unidade de duração inválida.");
  }

  if (!symbol) {
    throw new Error("Índice não seleccionado.");
  }

  const digitContracts = [
    "DIGITDIFF",
    "DIGITOVER",
    "DIGITUNDER",
    "DIGITMATCH"
  ];

  const payload = {
    proposal: 1,
    amount: stake,
    basis: "stake",
    contract_type: contractType,
    currency: currency,
    duration: duration,
    duration_unit: durationUnit,
    underlying_symbol: symbol
  };

  let proposalBarrier = null;

  if (digitContracts.includes(contractType)) {

   const rawPrediction = isRecoveryAtRequest
  ? recoveryPred(contractType)
  : bot.prediction;

const prediction =
  rawPrediction === null ||
  rawPrediction === undefined ||
  (typeof rawPrediction === "string" && rawPrediction.trim() === "")
    ? NaN
    : Number(rawPrediction);

    if (
      !Number.isInteger(prediction) ||
      prediction < 0 ||
      prediction > 9
    ) {
      throw new Error(
        "Barreira ou previsão de dígito inválida."
      );
    }

    proposalBarrier = String(prediction);
    payload.barrier = proposalBarrier;
  }

  // =========================================================
  // 3. SOLICITAR A PROPOSTA
  // =========================================================

  console.log(
    "TradeProJB: A solicitar proposta validada:",
    {
      account_id: connectedAccountId,
      symbol: symbol,
      contract_type: contractType,
      stake: stake,
      duration: duration,
      duration_unit: durationUnit,
      barrier: payload.barrier
    }
  );

  const response = await sendOptionsRequest(payload);

  // =========================================================
  // 4. CONFIRMAR QUE A SESSÃO NÃO MUDOU
  // =========================================================

const currentAccount = derivAccounts.find(function (item) {
  return String(item.account_id) === connectedAccountId;
});

let currentBarrier = null;

if (digitContracts.includes(contractType)) {
  const rawCurrentPrediction = bot.isRecovery
  ? recoveryPred(contractType)
  : bot.prediction;

const currentPrediction =
  rawCurrentPrediction === null ||
  rawCurrentPrediction === undefined ||
  (typeof rawCurrentPrediction === "string" && rawCurrentPrediction.trim() === "")
    ? NaN
    : Number(rawCurrentPrediction);
  
  if (
    Number.isInteger(currentPrediction) &&
    currentPrediction >= 0 &&
    currentPrediction <= 9
  ) {
    currentBarrier = String(currentPrediction);
  }
}

const sessionAndParametersValid =
  app.wsReady &&
  app.connectedAccountType === "demo" &&
  ws === socketAtRequest &&
  socketAtRequest.readyState === WebSocket.OPEN &&
  String(app.connectedAccountId) === connectedAccountId &&
  String(selectedAccountId) === connectedAccountId &&
  currentAccount &&
  String(currentAccount.status).toLowerCase() === "active" &&
  String(currentAccount.account_type).toLowerCase() === "demo" &&
  String(currentAccount.currency) === currency &&
  String(bot.symbol || "") === symbol &&
  String(bot.contractType || "").toUpperCase() === contractType &&
  Number(bot.currentStake) === stake &&
  Number(bot.duration) === duration &&
  String(bot.durationType) === durationUnit &&
  Boolean(bot.isRecovery) === isRecoveryAtRequest &&
  currentBarrier === proposalBarrier;

if (!sessionAndParametersValid) {
  throw new Error(
    "A ligação, a conta ou os parâmetros mudaram durante o pedido da proposta."
  );
}


  // =========================================================
  // 5. VALIDAR A RESPOSTA DA DERIV
  // =========================================================

  if (
    !response ||
    response.msg_type !== "proposal" ||
    !response.proposal
  ) {
    throw new Error(
      "A resposta recebida não é uma proposta válida."
    );
  }

  const proposal = response.proposal;

  if (
    typeof proposal.id !== "string" ||
    proposal.id.trim().length === 0
  ) {
    throw new Error(
      "A proposta não contém um ID válido."
    );
  }

  const askPrice = Number(proposal.ask_price);
  const payout = Number(proposal.payout);

  if (!Number.isFinite(askPrice) || askPrice <= 0) {
    throw new Error(
      "O preço da proposta é inválido."
    );
  }

  if (!Number.isFinite(payout) || payout <= 0) {
    throw new Error(
      "O payout da proposta é inválido."
    );
  }

  if (
    typeof proposal.longcode !== "string" ||
    proposal.longcode.trim().length === 0
  ) {
    throw new Error(
      "A descrição da proposta não foi recebida."
    );
  }

  
  // Confirmar os parâmetros devolvidos, quando disponíveis.
  const echoed = response.echo_req;

  if (
    echoed !== undefined &&
    (!echoed || typeof echoed !== "object" || Array.isArray(echoed))
  ) {
    throw new Error(
      "A resposta da Deriv contém parâmetros echo_req inválidos."
    );
  }

  if (echoed) {
    const hasEcho = function (key) {
      return Object.prototype.hasOwnProperty.call(echoed, key);
    };

    // 1. Confirmar índice
    if (
      hasEcho("underlying_symbol") &&
      echoed.underlying_symbol !== symbol
    ) {
      throw new Error(
        "A proposta devolvida pertence a outro índice."
      );
    }

    // 2. Confirmar tipo de contrato
    if (
      hasEcho("contract_type") &&
      echoed.contract_type !== contractType
    ) {
      throw new Error(
        "O tipo de contrato devolvido não corresponde ao pedido."
      );
    }

    // 3. Confirmar moeda
    if (
      hasEcho("currency") &&
      echoed.currency !== currency
    ) {
      throw new Error(
        "A moeda da proposta não corresponde à conta."
      );
    }

    // 4. Confirmar valor da aposta
    if (
      hasEcho("amount") &&
      (
        !Number.isFinite(Number(echoed.amount)) ||
        Number(echoed.amount) !== stake
      )
    ) {
      throw new Error(
        "O valor da proposta não corresponde ao valor solicitado."
      );
    }

    // 5. Confirmar base da aposta
    if (
      hasEcho("basis") &&
      echoed.basis !== "stake"
    ) {
      throw new Error(
        "A base da proposta não corresponde a stake."
      );
    }

    // 6. Confirmar duração
    if (
      hasEcho("duration") &&
      (
        !Number.isFinite(Number(echoed.duration)) ||
        Number(echoed.duration) !== duration
      )
    ) {
      throw new Error(
        "A duração devolvida não corresponde ao pedido."
      );
    }

    // 7. Confirmar unidade de duração
    if (
      hasEcho("duration_unit") &&
      echoed.duration_unit !== durationUnit
    ) {
      throw new Error(
        "A unidade de duração não corresponde ao pedido."
      );
    }

    // 8. Confirmar barreira, quando aplicável
    if (
      digitContracts.includes(contractType) &&
      hasEcho("barrier") &&
      String(echoed.barrier) !== proposalBarrier
    ) {
      throw new Error(
    "A barreira devolvida não corresponde à previsão solicitada."
      );
    }
  }


  // =========================================================
  // 6. REGISTAR O RESULTADO — SEM COMPRAR
  // =========================================================

  // C5 — Vincular a proposta à sessão e aos parâmetros originais
const proposalCreatedAt = Date.now();

proposalContexts.set(proposal, {
  proposal_id: proposal.id,
  account_id: connectedAccountId,
  socket: socketAtRequest,
  symbol: symbol,
  contract_type: contractType,
  stake: stake,
  duration: duration,
  duration_unit: durationUnit,
  currency: currency,
  barrier: proposalBarrier,
  is_recovery: isRecoveryAtRequest,
  ask_price: askPrice,
  created_at: proposalCreatedAt,
  expires_at: proposalCreatedAt + 30000
});
  console.log(
    "TradeProJB: Proposta validada com sucesso:",
    {
      account_id: connectedAccountId,
      proposal_id: proposal.id,
      contract_type: contractType,
      symbol: symbol,
      ask_price: askPrice,
      payout: payout,
      longcode: proposal.longcode
    }
  );

  return proposal;
}


// ============================================================
// TRADEPROJB — COMPRA OPTIONS API
// FASE B — IMPLEMENTAÇÃO PREPARADA
// NÃO EXECUTAR NESTA FASE
// ============================================================

async function buyContractOptions(proposal, authorizedMaxPrice) {

  if (app.purchaseInProgress) {
  throw new Error(
    "Já existe uma compra em processamento. Aguarde a resolução."
  );
}
    // B4 — Bloquear novas compras com tentativa não resolvida
  if (
    app.lastPurchaseAttempt &&
    ["PENDING", "UNKNOWN"].includes(app.lastPurchaseAttempt.status)
  ) {
    throw new Error(
      "Existe uma tentativa de compra pendente ou desconhecida. " +
      "Reconcilie o estado da compra antes de tentar novamente."
    );
  }

  // 1. VALIDAR A PROPOSTA

  if (!proposal || typeof proposal !== "object") {
    throw new Error("Proposta não fornecida.");
  }

  if (
    typeof proposal.id !== "string" ||
    proposal.id.trim().length === 0
  ) {
    throw new Error("ID da proposta inválido.");
  }

  const askPrice = Number(proposal.ask_price);
  const maxPrice = Number(authorizedMaxPrice);

  if (!Number.isFinite(askPrice) || askPrice <= 0) {
    throw new Error("Preço da proposta inválido.");
  }

  if (!Number.isFinite(maxPrice) || maxPrice <= 0) {
    throw new Error("Preço máximo autorizado inválido.");
  }

  if (maxPrice < askPrice) {
    throw new Error(
      "O preço máximo autorizado é inferior ao preço da proposta."
    );
  }

  // 2. VALIDAR A CONTA DEMO

  const accountId = String(app.connectedAccountId || "");
  const socket = ws;
  
if (
  !socket ||
  socket.readyState !== WebSocket.OPEN ||
  !app.wsReady ||
  app.connectedAccountType !== "demo"
) {
  throw new Error(
    "Options API não está ligada a uma conta Demo. Compra não enviada."
  );
}

  if (
    !accountId ||
    String(selectedAccountId) !== accountId
  ) {
    throw new Error(
      "A conta seleccionada não corresponde à conta ligada."
    );
  }

  const account = derivAccounts.find(function (item) {
    return String(item.account_id) === accountId;
  });

  if (
    !account ||
    String(account.status).toLowerCase() !== "active" ||
    String(account.account_type).toLowerCase() !== "demo"
  ) {
    throw new Error("A conta Demo não passou na validação.");
  }

  // 3. CONFIRMAR QUE A PROPOSTA AINDA PODE SER UTILIZADA

  if (
    !app.wsReady ||
    app.connectedAccountType !== "demo" ||
    ws !== socket ||
    socket.readyState !== WebSocket.OPEN ||
    String(app.connectedAccountId) !== accountId ||
    String(selectedAccountId) !== accountId
  ) {
    throw new Error(
      "A sessão mudou antes do envio da compra."
    );
  }

    // C-B4 — Validar o contexto original da proposta

  const proposalContext = proposalContexts.get(proposal);
  if (proposalContext && proposalContext.consumed) {
  throw new Error(
    "Esta proposta já foi utilizada. Solicite uma nova proposta."
  );
}

  if (!proposalContext) {
    throw new Error(
      "Proposta sem contexto original validado. Compra bloqueada."
    );
  }

  const digitContracts = [
    "DIGITDIFF",
    "DIGITOVER",
    "DIGITUNDER",
    "DIGITMATCH"
  ];

  let currentBarrier = null;

  if (digitContracts.includes(proposalContext.contract_type)) {
    const rawPrediction = bot.isRecovery
  ? recoveryPred(proposalContext.contract_type)
  : bot.prediction;

if (
  rawPrediction === null ||
  rawPrediction === undefined ||
  String(rawPrediction).trim() === ""
) {
  throw new Error("Dígito de previsão não seleccionado.");
}

const currentPrediction = Number(rawPrediction);

if (
  !Number.isInteger(currentPrediction) ||
  currentPrediction < 0 ||
  currentPrediction > 9
) {
  throw new Error("Dígito de previsão inválido.");
}

currentBarrier = String(currentPrediction);
  }

  const contextIsValid =
    proposalContext.proposal_id === proposal.id &&
    Date.now() <= proposalContext.expires_at &&
    proposalContext.socket === socket &&
    proposalContext.account_id === accountId &&
    proposalContext.symbol === String(bot.symbol || "") &&
    proposalContext.contract_type ===
      String(bot.contractType || "").toUpperCase() &&
    proposalContext.stake === Number(bot.currentStake) &&
    proposalContext.duration === Number(bot.duration) &&
    proposalContext.duration_unit === String(bot.durationType) &&
    proposalContext.currency === String(account.currency) &&
    proposalContext.is_recovery === Boolean(bot.isRecovery) &&
    proposalContext.barrier === currentBarrier &&
    proposalContext.ask_price === askPrice;

  if (!contextIsValid) {
    throw new Error(
      "A proposta expirou ou os parâmetros originais foram alterados. " +
      "Solicite uma nova proposta."
    );
  }

  // 4. ENVIAR A COMPRA OPTIONS API

  console.log(
    "TradeProJB: A enviar compra Options API:",
    {
      proposal_id: proposal.id,
      ask_price: askPrice,
      authorized_max_price: maxPrice,
      account_id: accountId
    }
  );

    const purchaseAttempt = {
    status: "PENDING",
    proposal_id: proposal.id,
    account_id: accountId,
    socket: socket,
    requested_price: maxPrice,
    startedAt: Date.now(),
    contract_id: null,
    transaction_id: null
  };

  app.lastPurchaseAttempt = purchaseAttempt;

// Marcar a proposta como utilizada antes do envio.
proposalContexts.set(proposal, {
  ...proposalContext,
  consumed: true,
  consumed_at: Date.now()
});

// Activar o bloqueio de compra.
// Activar o bloqueio de compra.
app.purchaseInProgress = true;

try {
  let response;

  // Enviar a compra e tratar os erros do pedido.
  try {
    response = await sendOptionsRequest({
      buy: proposal.id,
      price: maxPrice
    });

  } catch (error) {

    purchaseAttempt.updatedAt = Date.now();
    purchaseAttempt.reason = error.message;

    if (error.code === "BUY_UNKNOWN") {
      purchaseAttempt.status = "UNKNOWN";

      console.error(
        "[BUY UNKNOWN] Não repetir. É necessária reconciliação.",
        purchaseAttempt
      );

      throw error;
    }

    if (error.code === "DERIV_REJECTED") {
      purchaseAttempt.status = "REJECTED";

      console.error(
        "[BUY REJECTED] A Deriv rejeitou explicitamente a compra.",
        error.deriv_error || error.message
      );

      throw error;
    }

    if (error.code === "REQUEST_NOT_SENT") {
      purchaseAttempt.status = "NOT_SENT";

      console.warn(
        "[BUY NOT SENT] O pedido não chegou a ser enviado.",
        error.message
      );

      throw error;
    }

    // Qualquer outro erro é tratado conservadoramente.
    purchaseAttempt.status = "UNKNOWN";

    console.error(
      "[BUY UNKNOWN] Erro sem classificação segura. Não repetir.",
      error
    );

    throw error;
  }
  
  // 5. REGISTAR SE A SESSÃO CONTINUA VÁLIDA

  const sessionStillValid =
    app.wsReady &&
    app.connectedAccountType === "demo" &&
    ws === socket &&
    socket.readyState === WebSocket.OPEN &&
    String(app.connectedAccountId) === accountId &&
    String(selectedAccountId) === accountId;

  if (!sessionStillValid) {
    console.error(
      "TradeProJB: A sessão mudou durante a compra. " +
      "A confirmação recebida deverá ser preservada."
    );
  }

  // 6. VALIDAR A RESPOSTA DA DERIV
  // B4 — Validar resposta da compra
if (
  !response ||
  response.msg_type !== "buy" ||
  !response.buy
) {
  purchaseAttempt.status = "UNKNOWN";
  purchaseAttempt.updatedAt = Date.now();
  purchaseAttempt.reason =
    "Resposta inesperada após envio da compra.";

  console.error(
    "[BUY UNKNOWN] Resposta inesperada. Não repetir a compra.",
    response
  );

  throw new Error(
    "Estado da compra desconhecido. Consulte a conta antes de tentar novamente."
  );
}

const buy = response.buy;

// 1. Validar o ID do contrato
const contractId = Number(buy.contract_id);

if (
  !Number.isSafeInteger(contractId) ||
  contractId <= 0
) {
  purchaseAttempt.status = "UNKNOWN";
  purchaseAttempt.updatedAt = Date.now();
  purchaseAttempt.reason =
    "Resposta de compra recebida sem contract_id válido.";

  console.error(
    "[BUY UNKNOWN] Não foi possível identificar o contrato. Não repetir.",
    response
  );

  throw new Error(
    "Compra com estado desconhecido. É necessária reconciliação da conta."
  );
}

// 2. CONFIRMAR IMEDIATAMENTE A COMPRA
// Um contract_id válido confirma que a compra foi executada.
purchaseAttempt.status = "CONFIRMED";
purchaseAttempt.updatedAt = Date.now();
purchaseAttempt.contract_id = contractId;
purchaseAttempt.transaction_id =
  buy.transaction_id || null;

// 3. Verificar o preço sem desfazer a confirmação
const actualBuyPrice = Number(buy.buy_price);

let priceAnomaly = null;

if (
  !Number.isFinite(actualBuyPrice) ||
  actualBuyPrice <= 0
) {
  priceAnomaly = "Preço efectivo inválido.";
} else if (
  actualBuyPrice > maxPrice + 0.00000001
) {
  priceAnomaly =
    "Preço efectivo acima do limite autorizado.";
}

if (priceAnomaly) {
  purchaseAttempt.priceAnomaly = priceAnomaly;

  console.error(
    "[BUY CONFIRMED — PRICE ANOMALY]",
    {
      contract_id: contractId,
      requested_max_price: maxPrice,
      actual_buy_price: buy.buy_price,
      anomaly: priceAnomaly
    }
  );
}

// 4. Guardar os dados da compra
purchaseAttempt.actual_buy_price =
  Number.isFinite(actualBuyPrice) && actualBuyPrice > 0
    ? actualBuyPrice
    : null;

const result = {
  contract_id: contractId,
  buy_price: purchaseAttempt.actual_buy_price,
  proposal_id: proposal.id,
  account_id: accountId,
  transaction_id: buy.transaction_id || null,
  purchase_time: buy.purchase_time || null,
  longcode: buy.longcode || proposal.longcode || null,
  sessionValidAtConfirmation: sessionStillValid,
  priceAnomaly: priceAnomaly
};

  console.log(
    "TradeProJB: Compra Options API validada:",
    result
  );

  return result;
  } finally {
  app.purchaseInProgress = false;
}
}

// ============================================================
// TRADEPROJB — ACOMPANHAMENTO OPTIONS API
// ============================================================

async function startContractMonitor(contractId, onUpdate) {
  if (!contractId) {
    throw new Error("ID do contrato não informado.");
  }

  if (typeof onUpdate !== "function") {
    throw new Error("Função de actualização não informada.");
  }

  const id = String(contractId);

  if (activeContractMonitors[id]) {
    throw new Error(
      "Este contrato já está a ser acompanhado."
    );
  }

  const response = await sendOptionsRequest({
    proposal_open_contract: 1,
    contract_id: Number(contractId),
    subscribe: 1
  });

  const contract = response.proposal_open_contract;

  if (!contract || !contract.contract_id) {
    throw new Error(
      "A Deriv não devolveu os dados do contrato."
    );
  }

  const monitor = {
    contractId: id,
    subscriptionId: response.subscription?.id || null,
    onUpdate: onUpdate
  };

  activeContractMonitors[id] = monitor;

  console.log(
    "TradeProJB: Acompanhamento iniciado:",
    {
      contract_id: id,
      subscription_id: monitor.subscriptionId,
      status: contract.status
    }
  );

  // Entregar também a resposta inicial.
  onUpdate(contract);

  return {
    contractId: id,
    subscriptionId: monitor.subscriptionId
  };
}

async function stopContractMonitor(contractId) {
  const id = String(contractId);
  const monitor = activeContractMonitors[id];

  if (!monitor) {
    console.warn(
      "TradeProJB: Contrato não encontrado no acompanhamento:",
      id
    );
    return false;
  }

  delete activeContractMonitors[id];

  if (monitor.subscriptionId) {
    await sendOptionsRequest({
      forget: monitor.subscriptionId
    });
  }

  console.log(
    "TradeProJB: Acompanhamento cancelado:",
    id
  );

  return true;
}


// ============================================================
// TRADEPROJB — GESTÃO DINÂMICA DA SUBSCRIÇÃO DE TICKS
// ============================================================

async function changeSymbolSubscription(newSymbol) {
  if (!newSymbol || newSymbol === activeTickSymbol) {
    return;
  }

  if (
    !ws ||
    ws.readyState !== WebSocket.OPEN ||
    !app.wsReady ||
    app.connectedAccountType !== "demo"
  ) {
    console.log(
      "TradeProJB: Índice guardado para a próxima ligação:",
      newSymbol
    );
    return;
  }

  if (bot.running) {
    alert("Pare o bot antes de mudar de índice.");
    return;
  }

  if (symbolChangeInProgress) {
    console.warn(
      "TradeProJB: Já existe uma mudança de índice em curso."
    );
    return;
  }

  const socket = ws;
  const previousSubscriptionId = activeTickSubscriptionId;
  const previousSymbol = activeTickSymbol;

  symbolChangeInProgress = true;
  pendingSymbolChange = newSymbol;

  try {
    // 1. Cancelar a subscrição anterior.
    if (previousSubscriptionId) {
      sendSubscriptionRequest(
        socket,
        { forget: previousSubscriptionId },
        "forget",
        previousSymbol
      );
    }

    // 2. Limpar os dados do índice anterior.
    ticks = [];
    antiManip.digitHistory = [];
    antiManip.cooldownTrades = 0;

    activeTickSubscriptionId = null;
    activeTickSymbol = null;

    animatedBars.fill(0);
    animatedPcts.fill(0);

    const samplesElement = $("analysisSamples");
    if (samplesElement) {
      samplesElement.textContent = "0";
    }

    const priceElement = $("chartPrice");
    if (priceElement) {
      priceElement.textContent = "—";
    }

    // 3. Consultar contratos do novo índice.
    const contractsRequestId = sendSubscriptionRequest(
      socket,
      { contracts_for: newSymbol },
      "contracts_for",
      newSymbol
    );

    // 4. Subscrever os ticks do novo índice.
    const ticksRequestId = sendSubscriptionRequest(
      socket,
      {
        ticks: newSymbol,
        subscribe: 1
      },
      "subscribe",
      newSymbol
    );

    console.log("TradeProJB: Mudança de índice enviada:", {
      anterior: previousSymbol,
      novo: newSymbol,
      contractsRequestId: contractsRequestId,
      ticksRequestId: ticksRequestId
    });

  } catch (error) {
    symbolChangeInProgress = false;
    pendingSymbolChange = null;

    console.error(
      "TradeProJB: Erro ao mudar subscrição:",
      error
    );

    alert(
      "Não foi possível solicitar a mudança de índice: " +
      error.message
    );
  }
}

// ============================================================
// TRADEPROJB — SELECÇÃO DINÂMICA DE AMOSTRAS
// ============================================================

function getAnalysisTicks() {
  const mode = $("analysisMode")?.value || "ticks";

  const quantity = Math.max(
    1,
    Math.min(1000, Math.floor(
      Number($("analysisQuantity")?.value) || 200
    ))
  );

  if (!ticks.length) return [];

  // MODO TICKS: últimas N amostras
  if (mode === "ticks") {
    return ticks.slice(-quantity);
  }

  // Obter apenas ticks com época válida
  const validTicks = ticks.filter(t =>
    Number.isFinite(Number(t.epoch))
  );

  if (!validTicks.length) return [];

  // Referência temporal do último tick recebido
  const latestEpoch = Number(
    validTicks[validTicks.length - 1].epoch
  );

  const durationSeconds =
    mode === "seconds" ? quantity : quantity * 60;

  const cutoff = latestEpoch - durationSeconds;

  return validTicks.filter(t =>
    Number(t.epoch) >= cutoff
  );
}
// ==================== CHART ====================
function drawChart() {
  const canvas = $("chartCanvas");
  if (!canvas) return;

  const ctx = canvas.getContext("2d");

  const rect = canvas.parentElement.getBoundingClientRect();

  if (canvas.width !== rect.width - 32 || canvas.height !== rect.height - 60) {
    canvas.width = rect.width - 32;
    canvas.height = rect.height - 60;
  }

  const W = canvas.width;
  const H = canvas.height;

  ctx.clearRect(0, 0, W, H);

  if (ticks.length === 0) return;

  // ==========================
  // ÚLTIMOS TICKS
  // ==========================

  const recentTicks = getAnalysisTicks();

  if (recentTicks.length === 0) {
  animatedBars.fill(0);
  animatedPcts.fill(0);
  return;
}
  const digits = Array(10).fill(0);

  recentTicks.forEach(function (t) {
  const digit = Number.isInteger(t.digit)
    ? t.digit
    : Math.floor(Math.abs(t.quote * 100)) % 10;

  if (digit >= 0 && digit <= 9) {
    digits[digit]++;
  }
});

  // ==========================
  // RANKING
  // ==========================

  const ranking = digits
    .map((count, digit) => ({
      digit,
      count
    }))
    .sort((a, b) => b.count - a.count);

  const greenDigits = ranking.slice(0, 3).map((x) => x.digit);

  const orangeDigits = ranking.slice(3, 7).map((x) => x.digit);

  const redDigits = ranking.slice(7).map((x) => x.digit);

  const maxFreq = Math.max(...digits, 1);

  const barWidth = W / 10;

  // ==========================
  // GRID
  // ==========================

  ctx.strokeStyle = "rgba(255,255,255,0.06)";

  ctx.lineWidth = 1;

  for (let i = 0; i < 5; i++) {
    const y = (H / 4) * i;

    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(W, y);
    ctx.stroke();
  }

  // ==========================
  // TOP 3
  // ==========================

  ctx.fillStyle = "#ffffff";
  ctx.font = "bold 12px JetBrains Mono";
  ctx.textAlign = "left";

  if (ranking.length >= 3) {
    ctx.fillText(`TOP 1: ${ranking[0].digit} (${ranking[0].count})`, 10, 18);

    ctx.fillText(`TOP 2: ${ranking[1].digit} (${ranking[1].count})`, 10, 36);

    ctx.fillText(`TOP 3: ${ranking[2].digit} (${ranking[2].count})`, 10, 54);
  }

  // ==========================
  // COLUNAS
  // ==========================

  for (let digit = 0; digit < 10; digit++) {
    const freq = digits[digit];

    const targetPct = (freq / recentTicks.length) * 100;

    const targetHeight = (freq / maxFreq) * (H - 140);

    // ======================
    // ANIMAÇÃO SUAVE
    // ======================

    animatedBars[digit] += (targetHeight - animatedBars[digit]) * 0.1;

    animatedPcts[digit] += (targetPct - animatedPcts[digit]) * 0.1;

    const barHeight = animatedBars[digit];

    const pct = animatedPcts[digit];

    const x = digit * barWidth + 5;

    const y = H - barHeight - 30;

    // ======================
    // COR
    // ======================

    if (greenDigits.includes(digit)) {
      ctx.fillStyle = "#22c55e";
    } else if (orangeDigits.includes(digit)) {
      ctx.fillStyle = "#f59e0b";
    } else {
      ctx.fillStyle = "#ef4444";
    }

    // ======================
    // COLUNA
    // ======================

    ctx.fillRect(x, y, barWidth - 10, barHeight);

    // ======================
    // PERCENTAGEM
    // ======================

    ctx.fillStyle = "#ffffff";

    ctx.font = "bold 11px JetBrains Mono";

    ctx.textAlign = "center";

    ctx.fillText(pct.toFixed(1) + "%", x + (barWidth - 10) / 2, y - 8);

    // ======================
    // CONTAGEM
    // ======================

    ctx.fillText(freq, x + (barWidth - 10) / 2, y + 18);

    // ======================
    // DIGITO
    // ======================

    ctx.fillStyle = "#cbd5e1";

    ctx.font = "12px JetBrains Mono";

    ctx.fillText(digit, x + (barWidth - 10) / 2, H - 8);
  }
}

function animateChart() {
  drawChart();
  requestAnimationFrame(animateChart);
}

animateChart();

// ==================== TABS ====================
function switchTab(t) {
  $("tabControls").className =
    "panel-tab" + (t === "controls" ? " active" : "");

  $("tabHistory").className =
    "panel-tab" + (t === "history" ? " active" : "");

  $("panelControls").classList.toggle("hidden", t !== "controls");
  $("panelHistory").classList.toggle("hidden", t !== "history");
}

// ==================== UI UPDATE ====================
function updateUI() {
  var p = bot.totalProfit;
  $("statPL").textContent = (p >= 0 ? "+" : "") + p.toFixed(2);
  $("statPL").className = "stat-val mono " + (p >= 0 ? "green" : "red");
  $("statTrades").textContent = bot.totalTrades;
  $("statWL").textContent = bot.wins + "/" + bot.losses;
  var wr =
    bot.totalTrades > 0
      ? ((bot.wins / bot.totalTrades) * 100).toFixed(1)
      : "0.0";
  $("statWR").textContent = wr + "%";
  $("statWR").className =
    "stat-val mono " + (parseFloat(wr) >= 50 ? "green" : "red");
  $("statRecov").textContent = bot.recoveryIdx;
  $("statRecov").className =
    "stat-val mono " + (bot.isRecovery ? "red" : "muted");
  $("statusIndicator").style.display = bot.running ? "flex" : "none";
  $("headerBalance").innerHTML = bot.balance.toFixed(2) + " <small>USD</small>";
  $("chartSymbol").textContent = bot.symbol;
  $("recoveryBadge").style.display = bot.isRecovery ? "inline" : "none";
  $("liveStake").style.display = bot.running ? "flex" : "none";
  $("liveStakeVal").textContent = bot.currentStake.toFixed(2) + " USD";
  $("recoveryInfo").style.display = bot.isRecovery ? "block" : "none";
  if (bot.isRecovery)
    $("recoveryDetail").textContent =
      "Usando " + bot.contractType + " • " + bot.losses + " losses seguidos";
  $("histCount").textContent = bot.history.length;
  
  // Actualizar quantidade de ticks recebidos
  const samplesElement = $("analysisSamples");

if (samplesElement) {
  samplesElement.textContent = getAnalysisTicks().length;
}

  var am = $("statAntiManip");
  if (bot.manipulationDetected) {
    am.textContent = "⚠️ ALERTA";
    am.className = "stat-val mono shield-warn";
  } else {
    am.textContent = "✅ OK";
    am.className = "stat-val mono green";
  }
}

function addHistoryItem(r) {
  var list = $("historyList");
  if (bot.history.length === 1) list.innerHTML = "";
  var labels = {
    DIGITDIFF: "Differs",
    DIGITEVEN: "Even",
    DIGITODD: "Odd",
    DIGITOVER: "Over",
    DIGITUNDER: "Under",
    CALL: "Call",
    PUT: "Put"
  };
  var d = document.createElement("div");
  d.className = "hist-item";
  d.innerHTML =
    '<div class="hist-left">' +
    '<div class="hist-icon ' +
    r.result +
    '">' +
    (r.result === "win" ? "↗" : r.result === "skip" ? "🛡️" : "↘") +
    "</div>" +
    "<div>" +
    '<div class="hist-name">' +
    (r.result === "skip" ? "⏸ Pausado" : labels[r.ct] || r.ct) +
    "</div>" +
    '<div class="hist-stake mono">' +
    (r.result === "skip" ? r.reason : "Stake: " + r.stake.toFixed(2) + " USD") +
    "</div>" +
    "</div>" +
    "</div>" +
    '<div style="text-align:right">' +
    '<div class="hist-profit mono ' +
    (r.result === "win" ? "green" : r.result === "skip" ? "muted" : "red") +
    '">' +
    (r.result === "skip"
      ? "—"
      : (r.profit >= 0 ? "+" : "") + r.profit.toFixed(2)) +
    "</div>" +
    '<div class="hist-time">' +
    new Date().toLocaleTimeString("pt-BR") +
    "</div>" +
    "</div>";
  list.insertBefore(d, list.firstChild);
}


// ==================== SETTINGS ====================
function openSettings() {
  $("cfgStake").value = bot.initialStake;
  $("cfgSL").value = bot.stopLoss;
  $("cfgTP").value = bot.takeProfit;
  $("cfgDaily").value = bot.dailyTarget;

  $("cfgDuration").value = bot.duration;
  $("cfgDurType").value = bot.durationType;

  $("cfgWindowSize").value = antiManip.windowSize;
  $("cfgMaxRepeat").value = antiManip.maxRepeat;
  $("cfgCooldown").value = antiManip.cooldownDuration;

  $("settingsModal").classList.remove("hidden");
} 

function closeSettings() {
  $("settingsModal").classList.add("hidden");
}

function saveSettings() {
  const stake = Number($("cfgStake").value);
  const sl = Number($("cfgSL").value);
  const tp = Number($("cfgTP").value);
  const daily = Number($("cfgDaily").value);

  const duration = Number($("cfgDuration").value);
  const windowSize = Number($("cfgWindowSize").value);
  const maxRepeat = Number($("cfgMaxRepeat").value);
  const cooldown = Number($("cfgCooldown").value);

  if (
    !Number.isFinite(stake) || stake <= 0 ||
    !Number.isFinite(sl) || sl <= 0 ||
    !Number.isFinite(tp) || tp <= 0 ||
    !Number.isFinite(daily) || daily <= 0 ||
    !Number.isInteger(duration) || duration <= 0 ||
    !Number.isInteger(windowSize) || windowSize < 5 ||
    !Number.isInteger(maxRepeat) || maxRepeat < 2 ||
    !Number.isInteger(cooldown) || cooldown < 0
  ) {
    alert("Verifique os valores das configurações. Existem valores inválidos.");
    return;
  }

  if (bot.running) {
    alert("Pare o bot antes de alterar as configurações.");
    return;
  }

  bot.initialStake = stake;
  bot.currentStake = stake;
  bot.stopLoss = sl;
  bot.takeProfit = tp;
  bot.dailyTarget = daily;

  const previousSymbol = bot.symbol;
  const newSymbol = $("cfgSymbol").value;

  console.log("TradeProJB: Verificação do índice:", {
  previousSymbol,
  selectedSymbol: newSymbol
});

  bot.symbol = newSymbol;

  if (newSymbol !== previousSymbol) {
    changeSymbolSubscription(newSymbol);
  }

   bot.duration = duration;
   bot.durationType = $("cfgDurType").value;

  antiManip.windowSize = windowSize;
  antiManip.maxRepeat = maxRepeat;
  antiManip.cooldownDuration = cooldown;

  antiManip.digitHistory = [];
  antiManip.cooldownTrades = 0;

  $("settingsModal").classList.add("hidden");

  updateUI();

  console.log("TradeProJB: Configurações actualizadas.", {
    stake: bot.initialStake,
    stopLoss: bot.stopLoss,
    takeProfit: bot.takeProfit,
    dailyTarget: bot.dailyTarget,
    symbol: bot.symbol,
    duration: bot.duration,
    windowSize: antiManip.windowSize,
    maxRepeat: antiManip.maxRepeat,
    cooldown: antiManip.cooldownDuration
  });

  alert("Configurações guardadas com sucesso.");
}


// ==================== BOT LOGIC ====================
function roundUp05(v) {
  return parseFloat((Math.ceil(v * 20) / 20).toFixed(2));
}
function payoutMult(ct) {
  if (["DIGITOVER", "DIGITUNDER", "DIGITEVEN", "DIGITODD"].indexOf(ct) >= 0)
    return 1.9;
  if (["CALL", "PUT"].indexOf(ct) >= 0) return 1.85;
  return 1.5;
}
function recoveryPred(ct) {
  if (ct === "DIGITOVER") return 4;
  if (ct === "DIGITUNDER") return 5;
  return bot.prediction;
}

function processResult(profit, stake) {
  bot.totalTrades++;
  bot.totalProfit += profit;
  bot.balance += profit;
  var result = profit >= 0 ? "win" : "loss";
  var r = {
    ct: bot.contractType,
    stake: stake,
    profit: profit,
    result: result
  };
  bot.history.unshift(r);

  if (result === "win") {
    bot.wins++;
    bot.currentStake = bot.initialStake;
    bot.contractType = "DIGITDIFF";
    bot.recoveryIdx = 0;
    bot.isRecovery = false;
    bot.accLoss = 0;
  } else {
    bot.losses++;
    bot.accLoss += Math.abs(profit);
    bot.isRecovery = true;
    bot.contractType =
      recoveryContracts[bot.recoveryIdx % recoveryContracts.length];
    bot.recoveryIdx++;
    var mult = payoutMult(bot.contractType);
    bot.currentStake 
      = roundUp05(bot.accLoss / (mult - 1));
    if (bot.currentStake > bot.stopLoss) bot.currentStake = bot.stopLoss;
  }
  addHistoryItem(r);
  updateUI();
}

function buyContract() {
  var pred = bot.isRecovery ? recoveryPred(bot.contractType) : bot.prediction;
  var params = {
    proposal: 1,
    amount: bot.currentStake,
    basis: "stake",
    contract_type: bot.contractType,
    currency: "USD",
    duration: bot.duration,
    duration_unit: bot.durationType,
    symbol: bot.symbol
  };
  if (
    ["DIGITDIFF", "DIGITOVER", "DIGITUNDER", "DIGITMATCH"].indexOf(
      bot.contractType
    ) >= 0
  ) {
    params.barrier = String(pred);
  }
  return wsSend(params)
    .then(function (proposal) {
      if (proposal.error) throw proposal.error.message;
      return wsSend({ buy: proposal.proposal.id, price: bot.currentStake });
    })
    .then(function (buy) {
      if (buy.error) throw buy.error.message;
      if (buy.buy && buy.buy.contract_id) {
        wsSend({
          proposal_open_contract: 1,
          contract_id: buy.buy.contract_id,
          subscribe: 1
        }).catch(function () {});
      }
      return buy;
    });
}

function waitSold(cid) {
  return new Promise(function (resolve) {
    var done = false;
    handlers.sold = function (c) {
      if (done) return;
      if (String(c.contract_id) === String(cid)) {
        done = true;
        handlers.sold = null;
        resolve(c);
      }
    };
    setTimeout(function () {
      if (!done) {
        done = true;
        handlers.sold = null;
        resolve(null);
      }
    }, 60000);
  });
}

function delay(ms) {
  return new Promise(function (r) {
    setTimeout(r, ms);
  });
}

   function runBot() {

  if (!bot.running) return Promise.resolve();

  if (bot.totalProfit <= -bot.stopLoss) {
    stopBot();
    return Promise.resolve();
  }

  if (bot.totalProfit >= bot.takeProfit) {
    stopBot();
    return Promise.resolve();
  }

  if (bot.totalProfit >= bot.dailyTarget) {
    stopBot();
    return Promise.resolve();
  }
     
     // 🛡️ ANTI-MANIPULATION                                                                                                                                                                                                                                                                    CHECK
  var manipCheck = antiManip.shouldSkip();
  if (manipCheck.skip) {
    bot.manipulationDetected = true;
    bot.skippedTrades++;
    var skipEntry = {
      ct: bot.contractType,
      stake: 0,
      profit: 0,
      result: "skip",
      reason: manipCheck.reason
    };
    bot.history.unshift(skipEntry);
    addHistoryItem(skipEntry);
    $("histCount").textContent = bot.history.length;
    updateUI();
    return delay(2000).then(function () {
      return runBot();
    });
  }
  bot.manipulationDetected = false;
  updateUI();

  return buyContract()
    .then(function (buyData) {
      var cid = buyData.buy.contract_id;
      var bp = buyData.buy.buy_price;
      return waitSold(cid).then(function (sold) {
        if (!sold) {
          processResult(-bp, bp);
        } else {
          var profit =
            parseFloat(sold.profit) || parseFloat(sold.sell_price) - bp;
          processResult(profit, bp);
        }
      });
    })
    .catch(function (err) {
      console.error("Trade error:", err);
    })
    .then(function () {
      return delay(1500);
    })
    .then(function () {
      return runBot();
    });
}

function toggleBot() {
  if (bot.running) {
    stopBot();
  } else {
    startBot();
  }
}

async function startBot() {

  // 1. EVITAR PEDIDOS DUPLICADOS
  if (bot.proposalRequestInProgress) {
    console.log("TradeProJB: Já existe um pedido de proposta em curso.");
    return;
  }

  // 2. VALIDAR A LIGAÇÃO DEMO
  if (
    !app.wsReady ||
    app.connectedAccountType !== "demo" ||
    !ws ||
    ws.readyState !== WebSocket.OPEN
  ) {
    alert("Ligue primeiro uma conta DEMO da Deriv.");
    return;
  }

  // 3. VALIDAR O SÍMBOLO
  const selectedSymbol = $("cfgSymbol").value;

  if (!selectedSymbol || selectedSymbol !== activeTickSymbol) {
    alert("O símbolo seleccionado não está sincronizado com a subscrição de ticks.");
    return;
  }

  // 4. VALIDAR OS TICKS
  if (!Array.isArray(ticks) || ticks.length < 20) {
    alert("Aguarde até receber pelo menos 20 ticks válidos.");
    return;
  }

  // 5. VALIDAR A PREVISÃO
  const rawDigit = selectedDigit;

  const digit = (
    rawDigit === null ||
    rawDigit === undefined ||
    (typeof rawDigit === "string" && rawDigit.trim() === "")
  ) ? NaN : Number(rawDigit);

  if (
    !Number.isInteger(digit) ||
    digit < 0 ||
    digit > 9
  ) {
    alert("Seleccione um dígito válido entre 0 e 9.");
    return;
  }

  // 6. LER AS CONFIGURAÇÕES
  const initialStake = Number($("cfgStake").value);
  const stopLoss = Number($("cfgSL").value);
  const takeProfit = Number($("cfgTP").value);
  const dailyTarget = Number($("cfgDaily").value);
  const duration = Number($("cfgDuration").value);
  const durationType = $("cfgDurType").value;

  if (
    !Number.isFinite(initialStake) || initialStake <= 0 ||
    !Number.isFinite(stopLoss) || stopLoss <= 0 ||
    !Number.isFinite(takeProfit) || takeProfit <= 0 ||
    !Number.isFinite(dailyTarget) || dailyTarget <= 0 ||
    !Number.isInteger(duration) || duration <= 0 ||
    !["t", "s", "m", "h", "d"].includes(durationType)
  ) {
    alert("Verifique os valores das configurações.");
    return;
  }

  // 7. PREPARAR O MOTOR OPTIONS API
  bot.initialStake = initialStake;
  bot.stopLoss = stopLoss;
  bot.takeProfit = takeProfit;
  bot.dailyTarget = dailyTarget;
  bot.symbol = selectedSymbol;
  bot.duration = duration;
  bot.durationType = durationType;
  bot.prediction = digit;

  bot.currentStake = initialStake;
  bot.totalProfit = 0;
  bot.totalTrades = 0;
  bot.wins = 0;
  bot.losses = 0;
  bot.accLoss = 0;
  bot.isRecovery = false;
  bot.recoveryIdx = 0;
  bot.contractType = "DIGITDIFF";
  bot.history = [];
  bot.manipulationDetected = false;
  bot.skippedTrades = 0;

  antiManip.digitHistory = [];
  antiManip.cooldownTrades = 0;

  // 8. SOLICITAR PROPOSTA — SEM COMPRAR
  bot.proposalRequestInProgress = true;

  try {

    console.log(
      "[TradeProJB] A iniciar solicitação de proposta Options API."
    );

    const proposal = await requestContractProposal();

    // 9. APRESENTAR A PROPOSTA RECEBIDA
    console.log(
      "[TradeProJB] PROPOSTA RECEBIDA E VALIDADA:",
      {
        proposal_id: proposal.id,
        symbol: bot.symbol,
        contract_type: bot.contractType,
        barrier: bot.prediction,
        stake: bot.currentStake,
        ask_price: proposal.ask_price,
        payout: proposal.payout,
        longcode: proposal.longcode
      }
    );

    alert(
      "Proposta recebida e validada com sucesso!\n\n" +
      "Índice: " + bot.symbol + "\n" +
      "Contrato: " + bot.contractType + "\n" +
      "Dígito: " + bot.prediction + "\n" +
      "Stake: " + proposal.ask_price + " " + 
      (proposal.currency || "") + "\n" +
      "Payout: " + proposal.payout + "\n\n" +
      "Nenhuma compra foi realizada."
    );

  } catch (error) {

    console.error(
      "[TradeProJB] Erro ao solicitar proposta:",
      error
    );

    alert(
      "Não foi possível obter uma proposta:\n" +
      error.message
    );

  } finally {

    bot.proposalRequestInProgress = false;

  }
}

function stopBot() {
  bot.running = false;
  $("btnStart").style.display = "flex";
  $("btnStop").style.display = "none";
  document.querySelectorAll(".input-field, .digit-btn").forEach(function (e) {
    e.disabled = false;
  });
  updateUI();
}

function handleDisconnect() {
  // Parar o bot e actualizar o estado
  bot.running = false;
  app.wsReady = false;
  app.connectedAccountType = null;
  app.status = "idle";
  app.connectedAccountId = null;

  // Parar o Ping
  if (optionsPingTimer) {
    clearInterval(optionsPingTimer);
    optionsPingTimer = null;
  }

  // Fechar WebSocket
  if (ws) {
    const socket = ws;
    ws = null;
    socket.close();
  }

  // Limpar dados da sessão
  ticks = [];
  antiManip.digitHistory = [];
  antiManip.cooldownTrades = 0;
  handlers = {};

  // Reiniciar contador
  const samplesElement = $("analysisSamples");
  if (samplesElement) {
    samplesElement.textContent = "0";
  }

  // Regressar ao login usando as classes CSS
  $("dashboard").classList.add("hidden");
  $("dashboard").style.display = "none";

  $("loginScreen").classList.remove("hidden");
  $("loginScreen").style.display = "flex";
  
  // Limpar estado da conta
  app.token = null;
  derivAccounts = [];
  selectedAccountId = null;

  console.log("TradeProJB: Sessão desligada. Regresso ao login.");
  console.log("Desligamento executado.");
console.log("Login encontrado:", $("loginScreen"));
}

// ==================== DOM READY ====================
document.addEventListener("DOMContentLoaded", function () {
  initDigits();

  updateUI();

  handleDerivOAuthCallback().catch(function (error) {
    console.error("Erro no retorno OAuth:", error);

    alert(
      "Falha na autenticação Deriv: " + error.message
    );
  });
  $("analysisMode")?.addEventListener("change", () => {
  drawChart();

  const samplesElement = $("analysisSamples");
  if (samplesElement) {
    samplesElement.textContent = getAnalysisTicks().length;
  }
});

$("analysisQuantity")?.addEventListener("input", () => {
  drawChart();

  const samplesElement = $("analysisSamples");
  if (samplesElement) {
    samplesElement.textContent = getAnalysisTicks().length;
  }
});
});
