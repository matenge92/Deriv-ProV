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

let ticks = [],
  selectedDigit = 0;

let animatedBars = Array(10).fill(0);
let animatedPcts = Array(10).fill(0);

const app = {
  status: "idle", // idle | connecting | connected | running
  token: null,
  wsReady: false,
  connectedAccountType: null
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


function setAccountType(t) {
  accountType = t;

  $("btnDemo").className =
    "account-btn" + (t === "demo" ? " active" : "");

  $("btnReal").className =
    "account-btn" + (t === "real" ? " active" : "");

  $("realWarning").classList.toggle("hidden", t !== "real");

  // Sincronizar com a conta carregada
  const account = derivAccounts.find(function (item) {
    return (
      String(item.account_type).toLowerCase() === t &&
      String(item.status).toLowerCase() === "active"
    );
  });

  if (account) {
    selectedAccountId = account.account_id;
    $("accountSelect").value = account.account_id;
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
    return item.account_id === chosenAccountId;
  });

  if (account) {
    setAccountType(String(account.account_type).toLowerCase());

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

  // Nesta fase, permitir apenas testes Demo.
  if (selectedType !== "demo") {
    alert("Por segurança, nesta fase só podemos testar a conta DEMO.");
    return;
  }

  if (ws && ws.readyState === WebSocket.OPEN &&
      app.wsReady && app.connectedAccountType === selectedType) {
    console.log("TradeProJB: A conta Demo já está ligada.");
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

bot.manipulationDetected = false;

  if (ws) {
    try { ws.close(); } catch (_) {}
    ws = null;
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
        account_id: selectedAccountId
      })
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
        app.connectedAccountType = "demo";

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
    console.error(
      "TradeProJB Options API:",
      message.error.message || "Erro recebido."
    );
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

  if (ticks.length > 200) {
    ticks.shift();
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
        if (optionsPingTimer) {
          clearInterval(optionsPingTimer);
          optionsPingTimer = null;
        }
        app.wsReady = false;
        app.connectedAccountType = null;
        if (app.status !== "idle") app.status = "idle";

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

    console.error("TradeProJB: falha na ligação Demo:", error);
    alert("Não foi possível ligar à conta Demo: " + error.message);

    if (button) {
      button.disabled = false;
      button.textContent = "LIGAR CONTA";
    }
  }
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

  const recentTicks = ticks.slice(-200);

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
  samplesElement.textContent = ticks.length;
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

  $("cfgSymbol").value = bot.symbol;
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

  bot.symbol = $("cfgSymbol").value;
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
    bot.currentStake = roundUp05(bot.accLoss / (mult - 1));
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

  // 🛡️ ANTI-MANIPULATION CHECK
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

// ==================== CONNECT / START / STOP ====================

function startBot() {
  // BLOQUEIO DE SEGURANÇA:
  // O motor de operações ainda usa mensagens da API WebSocket antiga (v3).
  // Não permitir compras até migrarmos e validarmos o protocolo Options API.
  if (!app.wsReady || app.connectedAccountType !== "demo") {
    alert("Ligue primeiro uma conta DEMO da Deriv.");
    return;
  }

  alert("Ligação Demo confirmada. As operações continuam bloqueadas enquanto migramos o protocolo de negociação para a Options API.");
  return;

  bot.initialStake = parseFloat($("cfgStake").value) || 0.35;
  bot.stopLoss = parseFloat($("cfgSL").value) || 10;
  bot.takeProfit = parseFloat($("cfgTP").value) || 50;
  bot.dailyTarget = parseFloat($("cfgDaily").value) || 100;
  bot.symbol = $("cfgSymbol").value;
  bot.duration = parseInt($("cfgDuration").value) || 1;
  bot.durationType = $("cfgDurType").value;
  bot.prediction = selectedDigit;
  bot.currentStake = bot.initialStake;
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
  $("historyList").innerHTML =
    '<div class="empty-state">Nenhum trade realizado ainda</div>';
  bot.running = true;
  $("btnStart").style.display = "none";
  $("btnStop").style.display = "flex";
  document.querySelectorAll(".input-field, .digit-btn").forEach(function (e) {
    e.disabled = true;
  });
  updateUI();
  runBot();
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
  bot.running = false;
  app.wsReady = false;
  app.connectedAccountType = null;
  app.status = "idle";

  if (optionsPingTimer) {
    clearInterval(optionsPingTimer);
    optionsPingTimer = null;
  }

  if (ws) ws.close();
  ws = null;
  ticks = [];
  handlers = {};
  $("dashboard").style.display = "none";
  $("loginScreen").style.display = "flex";
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
});
