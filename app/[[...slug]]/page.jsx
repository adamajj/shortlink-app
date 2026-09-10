'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useParams } from 'next/navigation';

const RESERVED = new Set(['api', 'admin', 'create', 'login', 'settings', '_next', 'favicon.ico', 'ads.js']);
const inp = 'w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-2.5 text-sm text-slate-200 placeholder-slate-500';
const btn = 'rounded-lg bg-indigo-500 px-4 py-2.5 text-sm font-bold text-white hover:bg-indigo-400 disabled:cursor-not-allowed disabled:bg-slate-700 disabled:text-slate-500';

export default function Page() {
  const params = useParams();
  const segs = params?.slug ?? [];
  const isGate = segs.length === 1 && !RESERVED.has(segs[0].toLowerCase());
  return isGate ? <Gate slug={segs[0]} /> : <Dashboard />;
}

/* ================= shared helpers ================= */

async function api(path, opts = {}) {
  const res = await fetch(path, {
    method: opts.method || 'GET',
    headers: opts.body ? { 'Content-Type': 'application/json' } : undefined,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) { const e = new Error(data.error || 'Request failed'); e.code = res.status; throw e; }
  return data;
}

function Center({ children }) {
  return <div className="flex min-h-screen items-center justify-center p-4">{children}</div>;
}
function Card({ children }) {
  return <div className="w-full max-w-sm rounded-2xl border border-slate-800 bg-slate-900/80 p-8 shadow-2xl">{children}</div>;
}

function useCountdown(total) {
  const [left, setLeft] = useState(total ?? 0);
  useEffect(() => {
    if (total == null) return;
    const end = Date.now() + total * 1000; // timestamp-based: survives tab throttling
    setLeft(total);
    const id = setInterval(() => {
      const l = Math.max(0, Math.ceil((end - Date.now()) / 1000));
      setLeft(l);
      if (l <= 0) clearInterval(id);
    }, 250);
    return () => clearInterval(id);
  }, [total]);
  return { left, done: left <= 0, progress: total ? (total - left) / total : 1 };
}

function useAdblock(enabled) {
  const [blocked, setBlocked] = useState(false);
  useEffect(() => {
    if (!enabled) return;
    let done = false;
    const fin = (v) => { if (!done) { done = true; setBlocked(v); } };
    const bait = document.createElement('div');
    bait.className = 'adsbox ad-banner text-ad pub_300x250';
    bait.style.cssText = 'position:absolute;left:-9999px;top:-9999px;width:300px;height:250px;';
    document.body.appendChild(bait);
    fetch('/ads.js', { cache: 'no-store' })
      .then((r) => (r.ok ? r.text() : Promise.reject()))
      .then(() => setTimeout(() => fin(bait.offsetHeight === 0 || !window.__adsBaitLoaded), 300))
      .catch(() => fin(true));
    const t = setTimeout(() => fin(bait.offsetHeight === 0), 2000);
    return () => { clearTimeout(t); bait.remove(); };
  }, [enabled]);
  return blocked;
}

function injectAd(container, code) {
  container.innerHTML = '';
  if (!code) return;
  const tpl = document.createElement('template');
  tpl.innerHTML = code;
  // script tags pasted by the admin don't execute via innerHTML — re-create them
  tpl.content.querySelectorAll('script').forEach((old) => {
    const s = document.createElement('script');
    for (const a of old.attributes) s.setAttribute(a.name, a.value);
    s.text = old.textContent;
    container.appendChild(s);
  });
  tpl.content.querySelectorAll(':not(script)').forEach((n) => container.appendChild(n.cloneNode(true)));
}

function AdSlot({ code, className = '', label }) {
  const ref = useRef(null);
  useEffect(() => { if (ref.current) injectAd(ref.current, code); }, [code]);
  if (!code) return null;
  return (
    <div className={className}>
      {label && <div className="mb-1 text-center text-[10px] font-medium uppercase tracking-[0.2em] text-slate-500">{label}</div>}
      <div ref={ref} />
    </div>
  );
}

function Captcha({ provider, siteKey, onToken }) {
  const ref = useRef(null);
  const wid = useRef(null);
  const cb = useRef(onToken);
  cb.current = onToken;
  useEffect(() => {
    if (!siteKey) return;
    const conf = provider === 'HCAPTCHA'
      ? { src: 'https://js.hcaptcha.com/1/api.js?render=explicit', g: 'hcaptcha' }
      : { src: 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit', g: 'turnstile' };
    let cancelled = false;
    wid.current = null;
    const render = () => {
      if (cancelled || !ref.current || !window[conf.g] || wid.current !== null) return;
      wid.current = window[conf.g].render(ref.current, {
        sitekey: siteKey,
        theme: 'dark',
        callback: (t) => cb.current(t),
        'expired-callback': () => cb.current(null),
        'error-callback': () => cb.current(null),
      });
    };
    if (window[conf.g]) render();
    else {
      let s = document.querySelector(`script[data-cap="${conf.g}"]`);
      if (!s) { s = document.createElement('script'); s.src = conf.src; s.async = true; s.dataset.cap = conf.g; document.head.appendChild(s); }
      s.addEventListener('load', render);
    }
    return () => { cancelled = true; };
  }, [provider, siteKey]);
  if (!siteKey) return null;
  return <div className="flex justify-center"><div ref={ref} /></div>;
}

/* ================= dashboard (home / admin) ================= */

function Dashboard() {
  const [auth, setAuth] = useState('loading');
  useEffect(() => {
    api('/api/auth')
      .then((d) => setAuth(d.admin ? 'ok' : d.claimed ? 'login' : 'claim'))
      .catch(() => setAuth('login'));
  }, []);
  if (auth === 'loading') return <Center><div className="h-10 w-40 animate-pulse rounded-lg bg-slate-800" /></Center>;
  if (auth === 'claim') return <Center><Claim onDone={() => setAuth('ok')} /></Center>;
  if (auth === 'login') return <Center><Login onDone={() => setAuth('ok')} /></Center>;
  return <AdminPanel onLogout={() => setAuth('login')} />;
}

function Claim({ onDone }) {
  const [pw, setPw] = useState('');
  const [err, setErr] = useState(null);
  const submit = async (e) => {
    e.preventDefault();
    try { await api('/api/auth', { method: 'POST', body: { mode: 'claim', password: pw } }); onDone(); }
    catch (e2) { setErr(e2.message); }
  };
  return (
    <Center><Card>
      <h1 className="text-xl font-bold text-white">Set your admin password</h1>
      <p className="mt-2 text-sm text-slate-400">
        This is the one-time setup. This screen will never appear again after you save — do it now, right after deploying.
      </p>
      <form onSubmit={submit} className="mt-4 space-y-3">
        <input type="password" required minLength={8} placeholder="Password (min 8 characters)" className={inp}
          value={pw} onChange={(e) => setPw(e.target.value)} />
        {err && <p className="text-sm text-rose-400">{err}</p>}
        <button className={`${btn} w-full`}>Save &amp; sign in</button>
      </form>
    </Card></Center>
  );
}

function Login({ onDone }) {
  const [pw, setPw] = useState('');
  const [err, setErr] = useState(null);
  const submit = async (e) => {
    e.preventDefault();
    try { await api('/api/auth', { method: 'POST', body: { mode: 'login', password: pw } }); onDone(); }
    catch (e2) { setErr(e2.message); }
  };
  return (
    <Center><Card>
      <h1 className="text-xl font-bold text-white">Admin sign in</h1>
      <form onSubmit={submit} className="mt-4 space-y-3">
        <input type="password" required placeholder="Admin password" className={inp}
          value={pw} onChange={(e) => setPw(e.target.value)} />
        {err && <p className="text-sm text-rose-400">{err}</p>}
        <button className={`${btn} w-full`}>Sign in</button>
      </form>
    </Card></Center>
  );
}

function AdminPanel({ onLogout }) {
  const [tab, setTab] = useState('links');
  const die = useCallback((e) => { if (e && e.code === 401) onLogout(); }, [onLogout]);
  const tabs = [['links', 'Links'], ['ads', 'Ad Slots'], ['settings', 'Settings'], ['stats', 'Analytics']];
  return (
    <div className="mx-auto max-w-4xl p-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold text-white">ShortLink Admin</h1>
        <button onClick={async () => { await api('/api/auth', { method: 'POST', body: { mode: 'logout' } }).catch(() => {}); onLogout(); }}
          className="rounded-lg bg-slate-800 px-4 py-2 text-sm text-slate-300 hover:bg-slate-700">Log out</button>
      </div>
      <nav className="mt-4 flex gap-2">
        {tabs.map(([k, label]) => (
          <button key={k} onClick={() => setTab(k)}
            className={`rounded-lg px-4 py-2 text-sm font-semibold ${tab === k ? 'bg-indigo-500 text-white' : 'bg-slate-800 text-slate-300 hover:bg-slate-700'}`}>
            {label}
          </button>
        ))}
      </nav>
      <div className="mt-6">
        {tab === 'links' && <LinksTab die={die} />}
        {tab === 'ads' && <AdsTab die={die} />}
        {tab === 'settings' && <SettingsTab die={die} />}
        {tab === 'stats' && <StatsTab die={die} />}
      </div>
    </div>
  );
}

function LinksTab({ die }) {
  const [links, setLinks] = useState(null);
  const [form, setForm] = useState({ url: '', days: '', custom: '', countries: '' });
  const [msg, setMsg] = useState(null);
  const [err, setErr] = useState(null);
  const load = useCallback(() => { api('/api/links').then((d) => setLinks(d.links)).catch(die); }, [die]);
  useEffect(() => { load(); }, [load]);

  const create = async (e) => {
    e.preventDefault(); setErr(null); setMsg(null);
    const body = { url: form.url };
    if (form.days) body.days = parseInt(form.days, 10);
    if (form.custom) body.custom = form.custom;
    const cs = form.countries.split(',').map((s) => s.trim().toUpperCase()).filter((s) => /^[A-Z]{2}$/.test(s));
    if (cs.length) body.countries = cs;
    try {
      const d = await api('/api/links', { method: 'POST', body });
      setMsg(d.shortUrl);
      setForm({ url: '', days: '', custom: '', countries: '' });
      load();
    } catch (e2) { setErr(e2.message); die(e2); }
  };

  const del = async (id) => { try { await api(`/api/links/${id}`, { method: 'DELETE' }); load(); } catch (e) { die(e); } };
  const copy = (url) => navigator.clipboard?.writeText(url).catch(() => {});

  return (
    <div className="space-y-6">
      <form onSubmit={create} className="space-y-3 rounded-xl border border-slate-800 p-4">
        <input required type="url" placeholder="Destination URL — https://example.com/very/long/page" className={inp}
          value={form.url} onChange={(e) => setForm({ ...form, url: e.target.value })} />
        <div className="grid grid-cols-3 gap-2">
          <input type="number" min="1" placeholder="Expires in days" className={inp}
            value={form.days} onChange={(e) => setForm({ ...form, days: e.target.value })} />
          <input placeholder="Custom slug (optional)" className={inp}
            value={form.custom} onChange={(e) => setForm({ ...form, custom: e.target.value })} />
          <input placeholder="Country lock: US, DE" className={inp}
            value={form.countries} onChange={(e) => setForm({ ...form, countries: e.target.value })} />
        </div>
        <button className={btn}>Create short link</button>
        {err && <p className="text-sm text-rose-400">{err}</p>}
        {msg && (
          <p className="rounded-lg bg-emerald-500/10 p-3 text-sm text-emerald-300">
            Created: <b>{msg}</b>{' '}
            <button type="button" onClick={() => copy(msg)} className="ml-2 underline">copy</button>
          </p>
        )}
      </form>

      {links && (
        <div className="overflow-hidden rounded-xl border border-slate-800">
          <table className="w-full text-sm">
            <thead className="bg-slate-900 text-left text-xs uppercase text-slate-500">
              <tr><th className="p-3">Short</th><th className="p-3">Destination</th><th className="p-3">Clicks</th><th className="p-3">Unique</th><th className="p-3">Expires</th><th className="p-3"></th></tr>
            </thead>
            <tbody>
              {links.map((l) => {
                const short = `${typeof window !== 'undefined' ? window.location.origin : ''}/${l.slug}`;
                return (
                  <tr key={l.id} className="border-t border-slate-800">
                    <td className="p-3">
                      <a className="text-indigo-400 underline" href={short} target="_blank" rel="noreferrer">/{l.slug}</a>{' '}
                      <button onClick={() => copy(short)} className="ml-1 text-xs text-slate-500 hover:text-slate-300">copy</button>
                    </td>
                    <td className="max-w-[240px] truncate p-3 text-slate-400">{l.url}</td>
                    <td className="p-3">{l.clicks}</td>
                    <td className="p-3">{l.uniqueIps}</td>
                    <td className="p-3 text-slate-400">{l.expires ? String(l.expires).slice(0, 10) : '—'}</td>
                    <td className="p-3 text-right">
                      <button onClick={() => del(l.id)} className="rounded bg-rose-500/20 px-3 py-1 text-xs font-bold text-rose-300">Delete</button>
                    </td>
                  </tr>
                );
              })}
              {!links.length && <tr><td colSpan="6" className="p-6 text-center text-slate-500">No links yet — create one above.</td></tr>}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function AdsTab({ die }) {
  const [ads, setAds] = useState([]);
  const [draft, setDraft] = useState({ name: '', placement: 'banner', code: '' });
  const [err, setErr] = useState(null);
  const load = useCallback(() => { api('/api/ads').then((d) => setAds(d.ads)).catch(die); }, [die]);
  useEffect(() => { load(); }, [load]);

  const placements = [
    ['banner', 'Top banner (728×90)'],
    ['card', 'Card ad (inside gate)'],
    ['pop', 'Popunder / in-page push tag'],
  ];

  const add = async (e) => {
    e.preventDefault(); setErr(null);
    try { await api('/api/ads', { method: 'POST', body: draft }); setDraft({ name: '', placement: 'banner', code: '' }); load(); }
    catch (e2) { setErr(e2.message); die(e2); }
  };
  const toggle = async (ad) => { try { await api(`/api/ads/${ad.id}`, { method: 'PATCH', body: { active: !ad.active } }); load(); } catch (e) { die(e); } };
  const del = async (id) => { try { await api(`/api/ads/${id}`, { method: 'DELETE' }); load(); } catch (e) { die(e); } };

  return (
    <div className="space-y-6">
      <form onSubmit={add} className="space-y-3 rounded-xl border border-slate-800 p-4">
        <h2 className="font-semibold text-white">Add ad slot — paste the network&apos;s script exactly as given</h2>
        <div className="flex gap-2">
          <input required placeholder="Name (e.g. Monetag banner)" className={`${inp} flex-1`}
            value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
          <select className={inp} value={draft.placement} onChange={(e) => setDraft({ ...draft, placement: e.target.value })}>
            {placements.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </select>
        </div>
        <textarea required rows={4} placeholder='<script src="//network.com/tag.js"></script>' className={`${inp} font-mono text-xs`}
          value={draft.code} onChange={(e) => setDraft({ ...draft, code: e.target.value })} />
        <button className={btn}>Save slot</button>
        {err && <p className="text-sm text-rose-400">{err}</p>}
      </form>
      <div className="space-y-2">
        {ads.map((ad) => (
          <div key={ad.id} className="flex items-center justify-between rounded-lg border border-slate-800 p-3 text-sm">
            <div>
              <span className="font-semibold text-white">{ad.name}</span>
              <span className="ml-2 rounded bg-slate-800 px-2 py-0.5 text-xs">{ad.placement}</span>
            </div>
            <div className="flex gap-2">
              <button onClick={() => toggle(ad)} className={`rounded px-3 py-1 text-xs font-bold ${ad.active ? 'bg-emerald-500/20 text-emerald-300' : 'bg-slate-700 text-slate-300'}`}>
                {ad.active ? 'ACTIVE' : 'PAUSED'}
              </button>
              <button onClick={() => del(ad.id)} className="rounded bg-rose-500/20 px-3 py-1 text-xs font-bold text-rose-300">Delete</button>
            </div>
          </div>
        ))}
        {!ads.length && <p className="text-sm text-slate-500">No ad slots yet. Ad networks (Monetag, Adsterra…) approve sites after you deploy on a real domain — then paste their scripts here.</p>}
      </div>
    </div>
  );
}

function SettingsTab({ die }) {
  const [s, setS] = useState(null);
  const [saved, setSaved] = useState(false);
  const [err, setErr] = useState(null);
  const load = useCallback(() => { api('/api/settings').then((d) => setS(d.settings)).catch(die); }, [die]);
  useEffect(() => { load(); }, [load]);
  if (!s) return null;

  const save = async (patch) => {
    setSaved(false); setErr(null);
    try { const d = await api('/api/settings', { method: 'PUT', body: patch }); setS(d.settings); setSaved(true); setTimeout(() => setSaved(false), 2000); }
    catch (e) { setErr(e.message); die(e); }
  };

  return (
    <div className="space-y-5 rounded-xl border border-slate-800 p-4">
      <h2 className="font-semibold text-white">Gate settings</h2>
      <label className="block text-sm">
        Countdown duration: <b>{s.seconds}s</b> (5–30)
        <div className="mt-2 flex items-center gap-3">
          <input type="range" min="5" max="30" value={s.seconds} className="w-full"
            onChange={(e) => setS({ ...s, seconds: Number(e.target.value) })}
            onMouseUp={() => save({ seconds: s.seconds })} onTouchEnd={() => save({ seconds: s.seconds })} />
        </div>
      </label>
      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" checked={s.adblockGate} onChange={(e) => save({ adblockGate: e.target.checked })} />
        Block the gate page when an ad blocker is detected
      </label>
      <div className="grid gap-2 sm:grid-cols-2">
        <select className={inp} value={s.captchaProvider} onChange={(e) => save({ captchaProvider: e.target.value })}>
          <option value="TURNSTILE">Cloudflare Turnstile</option>
          <option value="HCAPTCHA">hCaptcha</option>
        </select>
        <input placeholder="Captcha site key (public)" className={inp} defaultValue={s.captchaSite}
          onBlur={(e) => e.target.value !== s.captchaSite && save({ captchaSite: e.target.value })} />
        <input placeholder={s.captchaSecretSet ? '•••• saved — type to replace' : 'Captcha secret key'} type="password" className={`${inp} sm:col-span-2`}
          onBlur={(e) => e.target.value && save({ captchaSecret: e.target.value })} />
      </div>
      {err && <p className="text-sm text-rose-400">{err}</p>}
      {saved && <p className="text-sm text-emerald-400">Saved ✓</p>}
      <p className="text-xs text-slate-500">
        Free Turnstile test keys for trying it out — site key <code>1x00000000000000000000AA</code>, secret <code>1x0000000000000000000000000000000AA</code>.
        Real keys: dash.cloudflare.com → Turnstile. While keys are empty the captcha step is skipped automatically.
      </p>
    </div>
  );
}

function StatsTab({ die }) {
  const [d, setD] = useState(null);
  const [days, setDays] = useState(30);
  useEffect(() => { api(`/api/analytics?days=${days}`).then(setD).catch(die); }, [days, die]);
  if (!d) return null;
  const maxC = Math.max(1, ...d.daily.map((x) => x.count));
  return (
    <div className="space-y-6">
      <select value={days} onChange={(e) => setDays(Number(e.target.value))} className={inp}>
        {[1, 7, 30, 90].map((x) => <option key={x} value={x}>Last {x} day(s)</option>)}
      </select>
      <div className="grid grid-cols-3 gap-3">
        {[['Total clicks', d.totals.clicks], ['Unique visitors', d.totals.uniqueIps], ['Links', d.totals.links]].map(([k, v]) => (
          <div key={k} className="rounded-xl border border-slate-800 p-4 text-center">
            <div className="text-2xl font-bold text-white">{v.toLocaleString()}</div>
            <div className="text-xs uppercase tracking-wide text-slate-500">{k}</div>
          </div>
        ))}
      </div>
      <div>
        <div className="mb-1 text-xs uppercase tracking-wide text-slate-500">Clicks per day</div>
        <div className="flex h-24 items-end gap-1">
          {d.daily.length ? d.daily.map((x) => (
            <div key={x.day} title={`${x.day}: ${x.count}`} className="flex-1 rounded-t bg-indigo-500/70"
              style={{ height: `${Math.max(4, (x.count / maxC) * 100)}%` }} />
          )) : <p className="text-sm text-slate-500">No clicks in this period.</p>}
        </div>
      </div>
      <div className="overflow-hidden rounded-xl border border-slate-800">
        <table className="w-full text-sm">
          <thead className="bg-slate-900 text-left text-xs uppercase text-slate-500">
            <tr><th className="p-3">Country</th><th className="p-3">Clicks</th><th className="p-3">Share</th></tr>
          </thead>
          <tbody>
            {d.geo.map((g) => (
              <tr key={g.country} className="border-t border-slate-800">
                <td className="p-3">{g.country}</td>
                <td className="p-3">{g.count.toLocaleString()}</td>
                <td className="p-3">{d.totals.clicks ? ((g.count / d.totals.clicks) * 100).toFixed(1) : 0}%</td>
              </tr>
            ))}
            {!d.geo.length && <tr><td colSpan="3" className="p-4 text-center text-slate-500">No geo data yet.</td></tr>}
          </tbody>
        </table>
      </div>
      <p className="text-xs text-slate-500">Devices: {d.devices.map((x) => `${x.device}: ${x.count}`).join(' · ') || '—'}</p>
    </div>
  );
}

/* ================= gate page (monetized interstitial) ================= */

function Gate({ slug }) {
  const [cfg, setCfg] = useState(null);
  const [fatal, setFatal] = useState(null); // 'notfound' | 'expired'
  const [cap, setCap] = useState(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);

  const secs = cfg?.seconds ?? 10;
  const { left, done, progress } = useCountdown(cfg ? secs : null);
  const adblocked = useAdblock(!!cfg?.adblockGate);

  useEffect(() => {
    fetch(`/api/gate/${encodeURIComponent(slug)}`)
      .then(async (r) => {
        const d = await r.json().catch(() => ({}));
        if (!r.ok) { setFatal(r.status === 410 ? 'expired' : 'notfound'); return; }
        setCfg(d);
      })
      .catch(() => setFatal('notfound'));
  }, [slug]);

  const go = async () => {
    if (!done || busy) return;
    if (cfg.captcha && !cap) return;
    setBusy(true); setErr(null);
    try {
      const v = await fetch(`/api/gate/${encodeURIComponent(slug)}/verify`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: cfg.token, captcha: cap }),
      });
      const vd = await v.json();
      if (!v.ok) throw new Error(vd.error || 'Verification failed');
      const g = await fetch(`/api/go/${encodeURIComponent(vd.redeem)}`);
      const gd = await g.json();
      if (!g.ok) throw new Error(gd.error || 'Could not retrieve your link');
      window.location.href = gd.url; // final client-side redirect
    } catch (e) { setErr(e.message); setBusy(false); }
  };

  if (fatal === 'adblock' || (cfg?.adblockGate && adblocked)) {
    return (
      <Center><Card>
        <div className="text-center text-4xl">🛡️</div>
        <h1 className="mt-3 text-center text-lg font-semibold text-white">Ad blocker detected</h1>
        <p className="mt-2 text-center text-sm text-slate-400">
          This service is funded by ads. Please disable your ad blocker for this site and reload.
        </p>
        <button onClick={() => window.location.reload()} className={`${btn} mt-5 w-full`}>I&apos;ve disabled it — retry</button>
      </Card></Center>
    );
  }
  if (fatal) {
    return (
      <Center><Card>
        <div className="text-center text-4xl">{fatal === 'expired' ? '⏳' : '🔎'}</div>
        <h1 className="mt-3 text-center text-lg font-semibold text-white">{fatal === 'expired' ? 'Link expired' : 'Link not found'}</h1>
      </Card></Center>
    );
  }
  if (!cfg) {
    return (
      <div className="min-h-screen bg-slate-950">
        <div className="mx-auto mt-6 h-[90px] w-full max-w-[728px] animate-pulse rounded bg-slate-900" />
        <Center><div className="w-full max-w-md animate-pulse rounded-2xl border border-slate-800 bg-slate-900/60 p-10">
          <div className="mx-auto h-4 w-2/3 rounded bg-slate-800" />
        </div></Center>
      </div>
    );
  }

  const solved = !cfg.captcha || Boolean(cap);
  const canGo = done && solved && !busy;

  return (
    <div className="min-h-screen bg-slate-950 text-slate-200">
      <header className="flex justify-center px-4 pt-6">
        <AdSlot code={cfg.ads?.banner} label="Advertisement"
          className="flex min-h-[90px] w-full max-w-[728px] items-center justify-center" />
      </header>

      <main className="flex min-h-[70vh] items-center justify-center px-4 py-10">
        <div className="w-full max-w-md rounded-2xl border border-slate-800 bg-slate-900/80 p-8 shadow-2xl ring-1 ring-white/5">
          <h1 className="text-center text-xl font-semibold text-white">Almost there!</h1>
          <p className="mt-2 text-center text-sm text-slate-400">
            {done ? 'Your link is ready — solve the captcha and continue.' : `Your link will be ready in ${left} seconds...`}
          </p>

          <div className="mt-5 h-2 overflow-hidden rounded-full bg-slate-800">
            <div className="h-full rounded-full bg-gradient-to-r from-indigo-500 to-cyan-400 transition-all duration-300"
              style={{ width: `${Math.round(progress * 100)}%` }} />
          </div>

          {cfg.ads?.card && (
            <div className="mt-6">
              <AdSlot code={cfg.ads.card} label="Sponsored" className="rounded-xl border border-slate-800 p-3" />
            </div>
          )}

          {cfg.captcha && (
            <div className="mt-6">
              <Captcha provider={cfg.captcha.provider} siteKey={cfg.captcha.site} onToken={setCap} />
            </div>
          )}

          {err && <p className="mt-4 rounded-lg bg-rose-500/10 px-3 py-2 text-center text-sm text-rose-400">{err}</p>}

          <button onClick={go} disabled={!canGo}
            className={`mt-6 w-full rounded-xl px-4 py-3.5 text-sm font-bold uppercase tracking-wider transition
              ${canGo ? 'bg-gradient-to-r from-indigo-500 to-cyan-500 text-white shadow-lg shadow-indigo-500/25 hover:brightness-110 active:scale-[0.99]'
                      : 'cursor-not-allowed bg-slate-800 text-slate-500'}`}>
            {busy ? 'Preparing your link…'
              : !done ? `Please wait ${left}s`
              : !solved ? 'Solve captcha to unlock'
              : 'Get Link'}
          </button>

          <p className="mt-4 text-center text-xs text-slate-500">
            Protected by captcha &amp; rate limiting. Your click supports this service.
          </p>
        </div>
      </main>

      {cfg.ads?.pop && (
        <div className="absolute h-px w-px overflow-hidden">
          <AdSlot code={cfg.ads.pop} />
        </div>
      )}
    </div>
  );
}
