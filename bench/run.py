#!/usr/bin/env python3
"""Banc d'essai GlucoVision — modeles de vision d'OpenRouter contre Nutrition5k.

Reproduit EXACTEMENT l'appel de js/estimator.js (meme SYSTEM_PROMPT, meme
prompt utilisateur en mode photo sans objet-repere, meme corps de requete).
"""
import base64, json, os, re, sys, threading, time, urllib.request, urllib.error
from concurrent.futures import ThreadPoolExecutor

HERE = os.path.dirname(os.path.abspath(__file__))
KEY = open(os.path.join(HERE, '.key')).read().strip()
URL = 'https://openrouter.ai/api/v1/chat/completions'
SYSTEM = open(os.path.join(HERE, 'system_prompt.txt')).read()
THINKING_MAX_TOKENS = 8000

# Parametres surchargeables par l'environnement. Les valeurs par defaut sont
# celles des deux premieres manches (BENCHMARK.md) : sans variable, le script
# rejoue exactement la mesure de juillet, ce qui doit rester possible.
BUDGET_USD = float(os.environ.get('BENCH_BUDGET', '4.00'))
SELECTIONS = os.environ.get('BENCH_SELECTION', 'selection.json').split(',')
OUT = os.environ.get('BENCH_OUT', 'resultats.json')

# Prompt utilisateur : mode photo, aucun objet-repere, une seule vue,
# pas de notes, pas d'extras, pas de bloc de calibration (buildUserPrompt).
USER_PROMPT = '\n'.join([
    'Analyse ce repas et estime les glucides selon la méthode.',
    "Aucun objet-repère : estime l'échelle via l'assiette/les couverts et baisse la confiance.",
    "Une seule vue : tu ne vois pas directement la hauteur/épaisseur — estime-la et",
    "signale-la comme seule inconnue géométrique (une photo de côté la lèverait).",
    'Réponds uniquement avec le JSON.',
])

MODELS = [
    'anthropic/claude-opus-5',
    'anthropic/claude-sonnet-5',
    'anthropic/claude-haiku-4.5',
    'google/gemini-3.6-flash',
    'google/gemini-3.1-flash-lite',
    'openai/gpt-5.6-terra',
    'openai/gpt-5.6-luna',
    'x-ai/grok-4.5',
    'qwen/qwen3-vl-235b-a22b-thinking',
    'qwen/qwen3-vl-235b-a22b-instruct',
    'qwen/qwen3.7-plus',
    'qwen/qwen3.7-flash',
    'z-ai/glm-4.6v',
    'mistralai/mistral-medium-3.1',
]

PRICES = {}  # rempli depuis models.json
for m in json.load(open(os.path.join(HERE, 'models.json')))['data']:
    p = m.get('pricing') or {}
    PRICES[m['id']] = (float(p.get('prompt') or 0), float(p.get('completion') or 0))

lock = threading.Lock()
spent = [0.0]


def parse_json(text):
    """Meme tolerance que parseJson() de estimator.js : le modele encadre
    parfois son JSON de ```json ... ``` ou de phrases."""
    if not text:
        raise ValueError('reponse vide')
    t = text.strip()
    t = re.sub(r'^```(?:json)?\s*', '', t)
    t = re.sub(r'\s*```$', '', t)
    try:
        return json.loads(t)
    except Exception:
        pass
    i, j = t.find('{'), t.rfind('}')
    if i != -1 and j > i:
        return json.loads(t[i:j + 1])
    raise ValueError('JSON introuvable')


def call(model, jpg_path):
    b64 = base64.b64encode(open(jpg_path, 'rb').read()).decode()
    body = {
        'model': model,
        'response_format': {'type': 'json_object'},
        'max_tokens': 16000 if re.search(r'thinking|plus|max', model) else THINKING_MAX_TOKENS,
        'messages': [
            {'role': 'system', 'content': SYSTEM},
            {'role': 'user', 'content': [
                {'type': 'text', 'text': USER_PROMPT},
                {'type': 'image_url', 'image_url': {'url': 'data:image/jpeg;base64,' + b64}},
            ]},
        ],
    }
    req = urllib.request.Request(URL, data=json.dumps(body).encode(), headers={
        'content-type': 'application/json',
        'Authorization': 'Bearer ' + KEY,
        'HTTP-Referer': 'https://rachid598.github.io/Diab-te/',
        'X-Title': 'GlucoVision',
    })
    t0 = time.time()
    with urllib.request.urlopen(req, timeout=300) as r:
        data = json.loads(r.read().decode())
    dt = time.time() - t0
    if data.get('error'):
        raise RuntimeError(data['error'].get('message', 'erreur API'))
    u = data.get('usage') or {}
    pin, pout = PRICES.get(model, (0, 0))
    cost = u.get('prompt_tokens', 0) * pin + u.get('completion_tokens', 0) * pout
    with lock:
        spent[0] += cost
    ch = (data.get('choices') or [{}])[0]
    txt = (ch.get('message') or {}).get('content')
    if not txt and ch.get('finish_reason') == 'length':
        raise RuntimeError('tronque (budget epuise en reflexion)')
    return parse_json(txt), cost, dt, u


def run_model(model, dishes):
    out = []
    for d in dishes:
        if spent[0] > BUDGET_USD:
            print('  !! budget atteint, arret', flush=True)
            break
        jpg = os.path.join(HERE, 'photos', d['id'] + '.jpg')
        rec = {'dish': d['id'], 'reel': d['gluc']}
        for attempt in range(3):
            try:
                res, cost, dt, u = call(model, jpg)
                rec.update(estime=float(res.get('totalCarbsG') or 0), cost=cost, sec=round(dt, 1),
                           seen=res.get('seen'), conf=res.get('overallConfidence'),
                           low=res.get('rangeLowG'), high=res.get('rangeHighG'),
                           items=[{'n': i.get('name'), 'g': i.get('carbsG'), 'm': i.get('estimatedMassG')}
                                  for i in (res.get('items') or [])],
                           tok=[u.get('prompt_tokens'), u.get('completion_tokens')])
                break
            except Exception as e:
                msg = str(e)[:160]
                if attempt == 2:
                    rec['erreur'] = msg
                else:
                    time.sleep(2 ** attempt * 3)
        out.append(rec)
        mark = 'X' if 'erreur' in rec else '%.0f/%.0f' % (rec['estime'], rec['reel'])
        print('  %-34s %-14s %s' % (model.split('/')[-1], d['id'][-6:], mark), flush=True)
    return out


def main():
    models = os.environ.get('BENCH_MODELS')
    models = [m.strip() for m in models.split(',') if m.strip()] if models else MODELS
    dishes, vus = [], set()
    for f in SELECTIONS:
        for d in json.load(open(os.path.join(HERE, f.strip()))):
            if d['id'] in vus:
                continue          # les deux manches peuvent se recouvrir
            vus.add(d['id'])
            dishes.append(d)
    print('%d plats x %d modeles = %d appels (budget $%.2f)\n'
          % (len(dishes), len(models), len(dishes) * len(models), BUDGET_USD))
    results = {}
    with ThreadPoolExecutor(max_workers=5) as ex:
        futs = {ex.submit(run_model, m, dishes): m for m in models}
        for f in futs:
            pass
        for f, m in futs.items():
            try:
                results[m] = f.result()
            except Exception as e:
                results[m] = [{'erreur': str(e)}]
            print('== %s termine (cumul $%.3f)' % (m, spent[0]), flush=True)
    json.dump(results, open(os.path.join(HERE, OUT), 'w'), ensure_ascii=False, indent=1)
    print('\nDepense totale : $%.4f' % spent[0])


if __name__ == '__main__':
    main()
