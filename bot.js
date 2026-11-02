const $ = (id) => document.getElementById(id);
// CONFIGURAÇÃO DA DERIV
const APP_ID = 1089;
const WS_URL = `wss://ws.derivws.com/websockets/v3?app_id=${APP_ID}`;
let accountType = "demo";
let ws = null,
  reqId = 0,
  pendingReqs = {},
  handlers = {};
let ticks = [],
  selectedDigit = 0;

let animatedBars = Array(10).fill(0);
let animatedPcts = Array(10).fill(0);

const app = {
  status: "idle", // idle | connecting | connected | running
  token: null
};
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

  pushDigit(quote) {
    const lastDigit = Math.floor(Math.abs(quote * 100)) % 10;
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
      this.cooldownTrades = 3;
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

// ==================== ACCOUNT TYPE ====================
function setAccountType(t) {
  accountType = t;
  $("btnDemo").className = "toggle-btn" + (t === "demo" ? " active" : "");
  $("btnReal").className = "toggle-btn" + (t === "real" ? " active-real" : "");
  $("realWarning").style.display = t === "real" ? "block" : "none";
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
        antiManip.pushDigit(d.tick.quote);
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

//==================== LOGINWITHDERIV ===================
function loginWithDeriv() {
  const appId = APP_ID;

  const redirectUri = encodeURIComponent(window.location.origin);

  const url = `https://oauth.deriv.com/oauth2/authorize?app_id=${appId}&redirect_uri=${redirectUri}`;

  window.location.href = url;
}

//============== LIMPA URL ===========================
function getOAuthTokenFromURL() {
  const hash = window.location.hash;
  if (!hash.includes("access_token")) return null;

  const params = new URLSearchParams(hash.replace("#", ""));
  const token = params.get("access_token");

  // limpa URL para não reprocessar login
  window.history.replaceState({}, document.title, window.location.pathname);

  return token;
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
    const digit = Math.floor(Math.abs(t.quote * 100)) % 10;

    digits[digit]++;
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
  $("tabControls").className = "tab" + (t === "controls" ? " active" : "");
  $("tabHistory").className = "tab" + (t === "history" ? " active" : "");
  $("panelControls").style.display = t === "controls" ? "flex" : "none";
  $("panelHistory").style.display = t === "history" ? "flex" : "none";
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

// ==================== CONNECT / START / STOP ====================

function startBot() {
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

  animateChart();
});
