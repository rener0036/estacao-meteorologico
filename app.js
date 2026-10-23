(function() {
  const CHANNEL_ID = 321770;
  const API_KEY = '0EPAIXIM4UL9LIW9';
  const RESULTS = 8000;

  const MG_FALLBACK_LAT = -18.9188;
  const MG_FALLBACK_LON = -48.2767;
  let stationLat = null, stationLon = null;

  const WIND_MAX_PLAUSIBLE_KMH = 150;
  let windOutlierCount = 0;
  let windOutlierSamples = [];

  const CO_WINDOW_HOURS = 8;
  const CO_COVERAGE_TOLERANCE_MIN = 15;
  const CO_LIMIT_PPM = 9;

  let lastParsedFeeds = [];
  let currentMode = '30000';
  let pollTimer = null;
  let isFetching = false;
  
  let inmetLoaded = false, monthlyLoaded = false, satelliteLoaded = false, cemadenLoaded = false;
  let satelliteProduct = 'true_color_ch13_dsa';
  let cemadenView = 'mapa';

  function toNum(v){ if(v==null || v==='') return null; const n=parseFloat(v); return isNaN(n)?null:n; }
  function pad(n){ return n.toString().padStart(2,'0'); }
  function fmt(v,dec=1){ return (v===null||v===undefined||isNaN(v)) ? '—' : v.toFixed(dec); }
  function fmtSigned(v,dec=1){ return (v===null||v===undefined||isNaN(v)) ? '—' : (v>=0?'+':'')+v.toFixed(dec); }
  function startOfToday(){ const d=new Date(); return new Date(d.getFullYear(),d.getMonth(),d.getDate()); }
  function sleep(ms){ return new Promise(r=>setTimeout(r,ms)); }
  function formatDateForApi(d){
    const str = `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
    return encodeURIComponent(str);
  }

  function sanitizeWind(raw, timeRef){
    if(raw === null) return null;
    if(raw > WIND_MAX_PLAUSIBLE_KMH){
      windOutlierCount++;
      windOutlierSamples.push({ value: raw, time: timeRef });
      return null;
    }
    return raw;
  }

  async function loadMetadata(){
    const el = document.getElementById('stationLocation');
    const urls = [
      `https://api.thingspeak.com/channels/${CHANNEL_ID}.json`,
      `https://api.thingspeak.com/channels/${CHANNEL_ID}.json?api_key=${API_KEY}`
    ];
    let info = null;
    for(const u of urls){
      try {
        const res = await fetch(u);
        if(!res.ok) continue;
        const data = await res.json();
        if(data && (data.name || data.latitude || data.longitude)){ info = data; break; }
      } catch(e) { console.warn("Aviso de metadados:", e); }
    }
    if(!info){ el.innerHTML = '📍 <span class="loc-warning">⚠️ Não foi possível obter metadados</span>'; return; }
    const name = info.name ? info.name.trim() : null;
    const lat = toNum(info.latitude), lon = toNum(info.longitude), elev = toNum(info.elevation);
    const hasCoords = lat!==null && lon!==null && !(lat===0 && lon===0);
    if(hasCoords){ stationLat = lat; stationLon = lon; }
    
    let html = name ? `<strong>${name}</strong>` : '';
    if(hasCoords){
      html += `${name?' — ':''}<span class="coord-badge">Lat: ${lat.toFixed(5)}° · Lon: ${lon.toFixed(5)}°</span>`;
      if(elev!==null && elev!==0) html += `<span class="coord-badge">Elevação: ${elev.toFixed(0)} m</span>`;
    } else {
      html += `${name?' — ':''}<span class="loc-warning">⚠️ Coordenadas não cadastradas</span>`;
    }
    el.innerHTML = '📍 ' + html;
  }

  async function fetchChannel(){
    const url = `https://api.thingspeak.com/channels/${CHANNEL_ID}/feeds.json?api_key=${API_KEY}&results=${RESULTS}`;
    const res = await fetch(url);
    if(!res.ok) throw new Error('HTTP ' + res.status);
    const data = await res.json();
    if(!data.feeds || data.feeds.length===0) throw new Error('Sem feeds retornados');
    return data.feeds;
  }

  async function fetchWindowWithRetry(start, end, maxRetries=3, backoffMs=800){
    let lastError = null;
    for(let attempt=1; attempt<=maxRetries; attempt++){
      try{
        const url = `https://api.thingspeak.com/channels/${CHANNEL_ID}/feeds.json?api_key=${API_KEY}&start=${formatDateForApi(start)}&end=${formatDateForApi(end)}&results=8000`;
        const res = await fetch(url);
        if(!res.ok){ lastError = new Error('HTTP '+res.status); if(res.status===429 || res.status>=500){ await sleep(backoffMs*attempt); continue; } throw lastError; }
        const data = await res.json();
        if(!Array.isArray(data.feeds)){ lastError=new Error('Resposta inválida'); await sleep(backoffMs*attempt); continue; }
        return { feeds: data.feeds, success: true };
      }catch(e){ lastError=e; await sleep(backoffMs*attempt); }
    }
    return { feeds: [], success:false, error: lastError ? lastError.message : 'Falha desconhecida' };
  }

  async function fetchCOWindow(now){
    const start8 = new Date(now.getTime() - CO_WINDOW_HOURS*60*60*1000);
    const result = await fetchWindowWithRetry(start8, now);
    if(!result.success) return { pts: [], start8, fetchError: result.error };
    const pts = result.feeds.map(f => ({ time: new Date(f.created_at), co: toNum(f.field7) })).filter(p => p.co !== null);
    return { pts, start8, fetchError: null };
  }

  function calcDewPoint(tempC, rh){
    if(tempC===null || rh===null || rh<=0 || rh>100) return null;
    const a = 17.27, b = 237.7;
    const gamma = (a*tempC)/(b+tempC) + Math.log(rh/100);
    const td = (b*gamma)/(a-gamma);
    return isFinite(td) ? td : null;
  }

  async function loadDashboard(){
    document.getElementById('loadError').textContent = '';
    document.getElementById('statusBar').classList.add('fetching');
    windOutlierCount = 0;
    windOutlierSamples = [];
    
    try{
      const feeds = await fetchChannel();
      const fc = feeds.map(f => {
        const time = new Date(f.created_at);
        const windRaw = toNum(f.field4);
        const wind = sanitizeWind(windRaw, time);
        return { time, temp: toNum(f.field1), hum: toNum(f.field2), pres: toNum(f.field3), wind, windRaw, co: toNum(f.field7) };
      });
      lastParsedFeeds = fc;
      const last = fc[fc.length-1];
      
      document.getElementById('lastFeedTime').textContent = last.time.toLocaleString('pt-BR');
      document.getElementById('windOutlierCount').textContent = windOutlierCount;

      const fToday = fc.filter(p => p.time >= startOfToday());
      const base = fToday.length>0 ? fToday : fc;
      document.getElementById('pointsCount').textContent = base.length;

      const temps = base.map(p=>p.temp).filter(v=>v!==null);
      if(temps.length){
        document.getElementById('tempMin').textContent = fmt(Math.min(...temps));
        document.getElementById('tempMax').textContent = fmt(Math.max(...temps));
        document.getElementById('tempAvg').textContent = fmt(temps.reduce((a,b)=>a+b,0)/temps.length);
      }

      const hums = base.map(p=>p.hum).filter(v=>v!==null);
      if(hums.length && last.hum!==null){
        const mh=Math.min(...hums), xh=Math.max(...hums);
        document.getElementById('humNow').textContent = fmt(last.hum,0);
        document.getElementById('humTime').textContent = 'Leitura em ' + last.time.toLocaleTimeString('pt-BR');
        document.getElementById('humRange').textContent = `${fmt(mh,0)}% a ${fmt(xh,0)}%`;
        document.getElementById('humBar').style.width = Math.max(4,Math.min(100,((last.hum-mh)/((xh-mh)||1))*100))+'%';
      }

      const press = base.map(p=>p.pres).filter(v=>v!==null);
      if(press.length && last.pres!==null){
        const pmin=Math.min(...press), pmax=Math.max(...press);
        document.getElementById('presNow').textContent = fmt(last.pres,1);
        document.getElementById('presTime').textContent = 'Leitura em ' + last.time.toLocaleTimeString('pt-BR');
        document.getElementById('presRange').innerHTML = `${fmt(pmin,1)} a ${fmt(pmax,1)}`;
        document.getElementById('presBar').style.width = Math.max(4,Math.min(100,((last.pres-pmin)/((pmax-pmin)||1))*100))+'%';
      }

      const lastWindValid = (() => { for(let i=fc.length-1;i>=0;i--){ if(fc[i].wind!==null) return fc[i]; } return null; })();
      const winds = fc.map(p=>p.wind).filter(v=>v!==null);
      if(winds.length && lastWindValid){
        document.getElementById('windNow').textContent = fmt(lastWindValid.wind,1);
        document.getElementById('windNowTime').textContent = 'Leitura em ' + lastWindValid.time.toLocaleTimeString('pt-BR');
        const maxWindPoint = fc.reduce((a,b)=> (b.wind!==null && (a===null || b.wind>a.wind)) ? b : a, null);
        if(maxWindPoint){
          document.getElementById('windGust').textContent = fmt(maxWindPoint.wind,1);
          document.getElementById('windGustTime').textContent = 'Pico em ' + maxWindPoint.time.toLocaleTimeString('pt-BR');
        }
      }

      const coWindowNow = (() => { for(let i=fc.length-1;i>=0;i--){ if(fc[i].co!==null) return fc[i].time; } return last.time; })();
      const { pts: coWindowPts, start8, fetchError: coFetchError } = await fetchCOWindow(coWindowNow);
      document.getElementById('coPointsCount').textContent = coWindowPts.length;

      let movAvg=null, coverageH=null, maxGapMin=null, isComplete=false;
      if(coWindowPts.length){
        movAvg = coWindowPts.reduce((a,b)=>a+b.co,0)/coWindowPts.length;
        const firstPt = coWindowPts[0];
        coverageH = (coWindowNow - firstPt.time)/(1000*60*60);
        maxGapMin = 0;
        for(let i=1;i<coWindowPts.length;i++){
          const gap = (coWindowPts[i].time - coWindowPts[i-1].time)/(1000*60);
          if(gap > maxGapMin) maxGapMin = gap;
        }
        isComplete = ((firstPt.time - start8)/(1000*60)) <= CO_COVERAGE_TOLERANCE_MIN;
        const lastco = coWindowPts[coWindowPts.length-1];
        document.getElementById('coNow').textContent = fmt(lastco.co,2);
        document.getElementById('coNowTime').textContent = 'Leitura em ' + lastco.time.toLocaleTimeString('pt-BR');
      }

      const coStatus = document.getElementById('coStatus');
      const coCard = document.getElementById('coCardAvg');
      if(movAvg!==null){
        document.getElementById('coMovAvg').textContent = fmt(movAvg,2);
        document.getElementById('coGaugeMarker').style.left = Math.min(100,(movAvg/12*100))+'%';
        if(!isComplete){
          coStatus.innerHTML = `⚠️ Cobertura incompleta`; coCard.className = 'card accent-warn';
        } else if(movAvg>CO_LIMIT_PPM){
          coStatus.innerHTML = `<span class="badge bad">Acima do padrão (${CO_LIMIT_PPM} ppm)</span>`; coCard.className = 'card accent-warn';
        } else {
          coStatus.innerHTML = '<span class="badge ok">Dentro do padrão</span>'; coCard.className = 'card accent-good';
        }
      } else {
        coStatus.textContent = 'Sem dados suficientes';
        coCard.className = 'card accent-warn';
      }

      document.getElementById('tableBody').innerHTML = fc.slice(-10).reverse().map(p => {
        const isOutlier = p.windRaw !== null && p.wind === null;
        const windCell = isOutlier ? `<span style="color:var(--warn);">⚠️ desc.</span>` : fmt(p.wind,1);
        return `<tr class="${isOutlier?'row-outlier':''}"><td>${p.time.toLocaleTimeString('pt-BR')}</td><td>${fmt(p.temp,1)}</td><td>${fmt(p.hum,0)}</td><td>${fmt(p.pres,1)}</td><td>${windCell}</td><td>${fmt(p.co,2)}</td></tr>`;
      }).join('');

      renderForecast(fc);

    }catch(e){
      console.error(e);
      document.getElementById('loadError').innerHTML = `<div class="limits">⚠️ Erro ao carregar dados: ${e.message}</div>`;
    } finally {
      document.getElementById('statusBar').classList.remove('fetching');
    }
  }

  function renderForecast(fc){
    const iconEl = document.getElementById('forecastIcon');
    const labelEl = document.getElementById('forecastMainLabel');
    const subEl = document.getElementById('forecastMainSub');
    const scoreEl = document.getElementById('forecastScoreValue');
    const factorsEl = document.getElementById('forecastFactors');
    
    if(!fc || !fc.length){ labelEl.textContent = 'Sem dados suficientes'; return; }
    function lastValid(key){ for(let i=fc.length-1;i>=0;i--){ if(fc[i][key]!==null) return fc[i]; } return null; }
    
    const lTemp = lastValid('temp'), lHum = lastValid('hum'), lWind = lastValid('wind'), lPres = lastValid('pres');
    if(!lTemp || !lHum){ labelEl.textContent = 'Dados insuficientes'; return; }

    const tempNow = lTemp.temp, humNow = lHum.hum, windNow = lWind ? lWind.wind : null, presNow = lPres ? lPres.pres : null;
    const dewNow = calcDewPoint(tempNow, humNow);
    const dewDepression = (dewNow!==null) ? (tempNow - dewNow) : null;

    document.getElementById('fTempNow').textContent = fmt(tempNow,1)+'°C';
    document.getElementById('fHumNow').textContent = fmt(humNow,0)+'%';
    document.getElementById('fDewNow').textContent = dewNow!==null ? fmt(dewNow,1)+'°C' : '—';
    document.getElementById('fDewDepr').textContent = dewDepression!==null ? fmt(dewDepression,1)+'°C' : '—';

    // Model Logic
    let fDew = dewDepression !== null ? Math.max(0, Math.min(100, 100 - (dewDepression/15)*100)) : 0;
    let fHum = Math.max(0, Math.min(100, ((humNow-40)/60)*100));
    let score = Math.max(0, Math.min(100, (fDew*0.30) + (fHum*0.25)));
    scoreEl.textContent = score.toFixed(0);

    if(score >= 70){ iconEl.textContent='🌧️'; labelEl.textContent='Alta chance de chuva'; subEl.textContent='Instabilidade forte.'; }
    else if(score >= 45){ iconEl.textContent='⛅'; labelEl.textContent='Possibilidade de nebulosidade'; subEl.textContent='Sinais mistos.'; }
    else { iconEl.textContent='☀️'; labelEl.textContent='Tempo estável/seco'; subEl.textContent='Baixa probabilidade de chuva.'; }
  }

  // --- OTIMIZAÇÃO: Polling baseado na Visibilidade (Aba do Navegador) ---
  async function loadDashboardLoop() {
    if(isFetching) return;
    if(document.visibilityState !== 'visible') {
      pollTimer = setTimeout(loadDashboardLoop, 10000); // Checa novamente devagar se a aba está oculta
      return;
    }
    isFetching = true;
    await loadDashboard();
    isFetching = false;
    
    const interval = currentMode === 'auto' ? 30000 : parseInt(currentMode, 10);
    pollTimer = setTimeout(loadDashboardLoop, interval);
  }

  function schedulePolling() {
    if (pollTimer) clearTimeout(pollTimer);
    loadDashboardLoop();
  }

  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") schedulePolling();
  });

  document.querySelectorAll('.toolbar .btn').forEach(btn=>{
    btn.addEventListener('click', ()=>{
      document.querySelectorAll('.toolbar .btn').forEach(b=>b.classList.remove('active'));
      btn.classList.add('active');
      currentMode = btn.dataset.interval;
      document.getElementById('currentInterval').textContent = currentMode === 'auto' ? '30s' : (parseInt(currentMode)/1000)+'s';
      schedulePolling();
    });
  });

  // --- OTIMIZAÇÃO: Requisições do Histórico Mensal em Paralelo ---
  async function fetchMonthAggregated(monthStart, monthEnd, onSubProgress){
    const subWindows = [];
    let cursor = new Date(monthStart);
    while(cursor < monthEnd){
      const winStart = new Date(cursor);
      const winEnd = new Date(cursor.getTime() + 2*24*60*60*1000 - 1000);
      subWindows.push({ start: winStart, end: winEnd > monthEnd ? monthEnd : winEnd });
      cursor = new Date(cursor.getTime() + 2*24*60*60*1000);
    }
    
    let allTemps = [], failedWindows = [];
    const BATCH_SIZE = 4; // Faz 4 requisições ao mesmo tempo
    
    for(let i=0; i < subWindows.length; i += BATCH_SIZE) {
       const batch = subWindows.slice(i, i + BATCH_SIZE);
       const promises = batch.map(async (w) => {
          const result = await fetchWindowWithRetry(w.start, w.end, 3, 800);
          if(onSubProgress) onSubProgress();
          return { w, result };
       });
       
       const batchResults = await Promise.all(promises);
       for(const item of batchResults) {
          if(!item.result.success) {
              failedWindows.push({ start: item.w.start.toLocaleDateString(), end: item.w.end.toLocaleDateString(), error: item.result.error });
          } else {
              const temps = item.result.feeds.map(f => toNum(f.field1)).filter(v => v !== null);
              allTemps = allTemps.concat(temps);
          }
       }
       await sleep(300); // Pausa leve para não bloquear API
    }
    return { temps: allTemps, failedWindows, totalSubWindows: subWindows.length };
  }

  function buildLast12MonthsSkeleton(){
    const now = new Date();
    const months = [];
    for(let i=11;i>=0;i--){
      const ref = new Date(now.getFullYear(), now.getMonth()-i, 1);
      months.push({ label: ref.toLocaleDateString('pt-BR', {month:'short', year:'2-digit'}), start: new Date(ref.getFullYear(), ref.getMonth(), 1, 0,0,0), end: new Date(ref.getFullYear(), ref.getMonth()+1, 0, 23,59,59) });
    }
    return months;
  }

  async function loadMonthlyHistory(){
    monthlyLoaded = true;
    document.getElementById('monthlyLoading').style.display = 'block';
    const months = buildLast12MonthsSkeleton();
    let doneSubWindows = 0;
    const totalSubWindows = months.reduce((sum,m)=> sum + Math.max(1, Math.ceil((m.end - m.start) / (24*60*60*1000) / 2)), 0);
    const results = [];

    const monthsWithFailures = [], emptyMonths = [];
    for(let i=0;i<months.length;i++){
      document.getElementById('monthlyProgressStatus').textContent = `Coletando ${months[i].label} (${i+1}/12)…`;
      const { temps, failedWindows } = await fetchMonthAggregated(months[i].start, months[i].end, ()=>{ 
        doneSubWindows++; document.getElementById('monthlyProgress').style.width = ((doneSubWindows/totalSubWindows)*100)+'%'; 
      });
      const hasFailures = failedWindows.length > 0;
      if(hasFailures) monthsWithFailures.push({ label: months[i].label, failedWindows });
      if(temps.length){ results.push({ label:months[i].label, min:Math.min(...temps), avg:temps.reduce((a,b)=>a+b,0)/temps.length, max:Math.max(...temps), count:temps.length, hasFailures, failedCount: failedWindows.length }); }
      else { results.push({ label:months[i].label, min:null, avg:null, max:null, count:0, hasFailures, failedCount: failedWindows.length }); emptyMonths.push(months[i].label); }
    }
    
    const allVals = results.flatMap(r=>[r.min,r.avg,r.max]).filter(v=>v!==null);
    const globalMax = allVals.length ? Math.max(...allVals) : 40;
    const globalMin = allVals.length ? Math.min(...allVals) : 0;
    const range = Math.max(1, globalMax - globalMin);
    const CHART_HEIGHT_PX = 200;
    function heightFor(v){ if(v===null) return 0; return Math.max(4, ((v - globalMin) / range) * CHART_HEIGHT_PX); }

    document.getElementById('monthlyChart').innerHTML = results.map(r => `
      <div class="monthly-month-col">
        <div class="monthly-bars">
          ${r.min!==null ? `<div class="monthly-bar min ${r.hasFailures?'warnFlag':''}" style="height:${heightFor(r.min)}px;"><span class="val">${fmt(r.min,1)}</span></div>` : `<div class="monthly-bar min" style="height:2px;opacity:.2;"></div>`}
          ${r.avg!==null ? `<div class="monthly-bar avg ${r.hasFailures?'warnFlag':''}" style="height:${heightFor(r.avg)}px;"><span class="val">${fmt(r.avg,1)}</span></div>` : `<div class="monthly-bar avg" style="height:2px;opacity:.2;"></div>`}
          ${r.max!==null ? `<div class="monthly-bar max ${r.hasFailures?'warnFlag':''}" style="height:${heightFor(r.max)}px;"><span class="val">${fmt(r.max,1)}</span></div>` : `<div class="monthly-bar max" style="height:2px;opacity:.2;"></div>`}
        </div>
        <div class="monthly-month-label">${r.label}<span class="n">${r.count} leit.</span>${r.hasFailures?`<span class="w">⚠️ ${r.failedCount} falha(s)</span>`:''}</div>
      </div>
    `).join('');

    document.getElementById('monthlyTableBody').innerHTML = results.map(r=>{
      const rowClass = r.count===0 ? 'row-empty' : (r.hasFailures ? 'row-partial' : '');
      const status = r.count===0 ? '<span class="badge bad">Sem dados</span>' : (r.hasFailures ? `<span class="badge warn">Parcial</span>` : '<span class="badge ok">Completo</span>');
      return `<tr class="${rowClass}"><td>${r.label}</td><td>${fmt(r.min,1)}</td><td>${fmt(r.avg,1)}</td><td>${fmt(r.max,1)}</td><td>${r.count}</td><td>${status}</td></tr>`;
    }).join('');

    document.getElementById('monthlyChartWrap').style.display = 'block';
    document.getElementById('monthlyTable').style.display = 'table';
    document.getElementById('btnReloadMonthly').style.display = 'inline-block';
    document.getElementById('monthlyLoading').style.display = 'none';
  }

  document.getElementById('btnReloadMonthly').addEventListener('click', ()=>{ monthlyLoaded = false; loadMonthlyHistory(); });

  // --- INMET / Open-Meteo ---
  async function tryFetchOpenMeteo(){
    const hasStationCoords = stationLat !== null && stationLon !== null;
    const lat = hasStationCoords ? stationLat : MG_FALLBACK_LAT;
    const lon = hasStationCoords ? stationLon : MG_FALLBACK_LON;
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&current=temperature_2m,relative_humidity_2m,pressure_msl,wind_speed_10m&wind_speed_unit=kmh&timezone=auto`;
    const res = await fetch(url);
    if(!res.ok) throw new Error('HTTP ' + res.status);
    const data = await res.json();
    if(!data || !data.current) throw new Error('Resposta sem dados meteorológicos');
    const c = data.current;
    return {
      source: `Open-Meteo${hasStationCoords ? ' (coordenadas da estação)' : ' (fallback regional)'} — lat ${lat.toFixed(4)}, lon ${lon.toFixed(4)}`,
      record: { timeRef: new Date(c.time), temp: toNum(c.temperature_2m), hum: toNum(c.relative_humidity_2m), pres: toNum(c.pressure_msl), wind: toNum(c.wind_speed_10m) }
    };
  }

  function buildCompareRow(label, localVal, localTime, refVal, refTime, unit, dec){
    const diff = (localVal !== null && refVal !== null) ? (localVal - refVal) : null;
    return `<tr><td>${label}</td><td>${localVal !== null ? fmt(localVal,dec)+' '+unit : '—'}</td><td>${localTime ? localTime.toLocaleString('pt-BR') : '—'}</td><td>${refVal !== null ? fmt(refVal,dec)+' '+unit : '—'}</td><td>${refTime ? refTime.toLocaleString('pt-BR') : '—'}</td><td>${diff !== null ? fmtSigned(diff,dec)+' '+unit : '—'}</td></tr>`;
  }

  async function loadInmetComparison(){
    inmetLoaded = true;
    const statusEl = document.getElementById('inmetStatus');
    const contentEl = document.getElementById('inmetContent');
    const tableEl = document.getElementById('inmetCompareTable');
    
    statusEl.style.display = 'block'; contentEl.style.display = 'none'; tableEl.style.display = 'none';
    statusEl.textContent = 'Consultando API Open-Meteo...';

    try {
      const result = await tryFetchOpenMeteo();
      document.getElementById('inmetSourceLabel').innerHTML = `✅ Fonte utilizada: <strong>${result.source}</strong>.`;
      
      if(!lastParsedFeeds.length){ statusEl.textContent = '⚠️ Dados do sensor local ainda não carregados.'; return; }
      
      function localLastValid(key){ for(let i=lastParsedFeeds.length-1;i>=0;i--){ if(lastParsedFeeds[i][key]!==null) return lastParsedFeeds[i]; } return null; }
      const lTemp = localLastValid('temp'), lHum = localLastValid('hum'), lPres = localLastValid('pres'), lWind = localLastValid('wind');
      const ref = result.record;

      statusEl.style.display = 'none';
      contentEl.style.display = 'block';
      contentEl.innerHTML = `<p><strong>Referência:</strong> leitura pontual obtida em ${ref.timeRef.toLocaleString('pt-BR')}.</p>`;

      document.getElementById('inmetCompareBody').innerHTML = 
        buildCompareRow('Temperatura', lTemp?.temp, lTemp?.time, ref.temp, ref.timeRef, '°C', 1) +
        buildCompareRow('Umidade', lHum?.hum, lHum?.time, ref.hum, ref.timeRef, '%', 0) +
        buildCompareRow('Pressão', lPres?.pres, lPres?.time, ref.pres, ref.timeRef, 'hPa', 1) +
        buildCompareRow('Vento', lWind?.wind, lWind?.time, ref.wind, ref.timeRef, 'km/h', 1);
        
      tableEl.style.display = 'table';
    } catch(err) {
      statusEl.innerHTML = `⚠️ Falha ao consultar a Open-Meteo: ${err.message}.`;
    }
  }

  // --- Satélite (INPE/CPTEC) ---
  function renderSatelliteFrame(){
    const url = `https://www.cptec.inpe.br/dsat/?product=${satelliteProduct}&legend=true&options=false&zoom=6&x=3620&y=3260`;
    document.getElementById('satFrameWrap').innerHTML = `<iframe src="${url}" style="width:100%;height:560px;border:none;background:#000;" loading="lazy" referrerpolicy="no-referrer-when-downgrade"></iframe>`;
  }
  document.getElementById('satLoadBtn')?.addEventListener('click', ()=>{ satelliteLoaded = true; renderSatelliteFrame(); });
  document.getElementById('satBtnTrueColor')?.addEventListener('click', (e)=>{ satelliteProduct = 'true_color_ch13_dsa'; document.querySelectorAll('#tabSatellite .ext-controls .btn').forEach(b=>b.classList.remove('active')); e.target.classList.add('active'); if(satelliteLoaded) renderSatelliteFrame(); });
  document.getElementById('satBtnIR')?.addEventListener('click', (e)=>{ satelliteProduct = 'ch13_dsa'; document.querySelectorAll('#tabSatellite .ext-controls .btn').forEach(b=>b.classList.remove('active')); e.target.classList.add('active'); if(satelliteLoaded) renderSatelliteFrame(); });

  // --- Alertas CEMADEN ---
  function renderCemadenFrame(){
    const url = cemadenView === 'alertas' ? 'https://www.gov.br/cemaden/pt-br' : 'https://mapainterativo.cemaden.gov.br/';
    document.getElementById('cemadenFrameWrap').innerHTML = `<iframe src="${url}" style="width:100%;height:560px;border:none;background:#000;" loading="lazy" referrerpolicy="no-referrer-when-downgrade"></iframe>`;
  }
  document.getElementById('cemadenLoadBtn')?.addEventListener('click', ()=>{ cemadenLoaded = true; renderCemadenFrame(); });
  document.getElementById('cemadenBtnMapa')?.addEventListener('click', (e)=>{ cemadenView = 'mapa'; document.querySelectorAll('#tabCemaden .ext-controls .btn').forEach(b=>b.classList.remove('active')); e.target.classList.add('active'); if(cemadenLoaded) renderCemadenFrame(); });
  document.getElementById('cemadenBtnAlertas')?.addEventListener('click', (e)=>{ cemadenView = 'alertas'; document.querySelectorAll('#tabCemaden .ext-controls .btn').forEach(b=>b.classList.remove('active')); e.target.classList.add('active'); if(cemadenLoaded) renderCemadenFrame(); });

  // Controle de abas
  document.querySelectorAll('.tab-btn').forEach(btn=>{
    if(btn.id === 'btnReloadMonthly') return;
    btn.addEventListener('click',()=>{
      document.querySelectorAll('.tab-btn').forEach(b=>{ if(b.id!=='btnReloadMonthly') b.classList.remove('active'); });
      document.querySelectorAll('.tab-panel').forEach(p=>p.classList.remove('active'));
      btn.classList.add('active');
      document.getElementById(btn.dataset.tab).classList.add('active');
      
      if(btn.dataset.tab==='tabForecast' && lastParsedFeeds.length > 0) renderForecast(lastParsedFeeds);
      if(btn.dataset.tab==='tabMonthly' && !monthlyLoaded) loadMonthlyHistory();
      if(btn.dataset.tab==='tabInmet' && !inmetLoaded) loadInmetComparison();
    });
  });

  // Init
  loadMetadata();
  schedulePolling();
})();
