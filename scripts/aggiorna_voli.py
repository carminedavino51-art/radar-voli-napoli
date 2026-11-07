#!/usr/bin/env python3
"""
Radar Voli Napoli - raccolta dati.

Scarica gli aerei che volano intorno all'aeroporto di Napoli Capodichino
da un servizio pubblico ADS-B e prepara due file JSON per il sito:

  sito/data/voli.json     -> gli aerei in volo adesso
  sito/data/storico.json  -> quanti aerei c'erano nelle ultime 24 ore

Lo script gira in automatico su GitHub Actions (vedi .github/workflows/aggiorna.yml).
Usa solo la libreria standard di Python: niente da installare.
"""

import json
import math
import os
import sys
import time
import urllib.error
import urllib.request

# --- Impostazioni -----------------------------------------------------------

LAT, LON = 40.886, 14.291          # Aeroporto di Napoli Capodichino
RAGGIO_NM = 40                     # raggio di ricerca in miglia nautiche (~74 km)
ORE_STORICO = 24                   # quante ore di storico tenere

# Due fonti con lo stesso formato dati: se la prima non risponde, si prova la seconda.
FONTI = [
    ("adsb.lol", f"https://api.adsb.lol/v2/lat/{LAT}/lon/{LON}/dist/{RAGGIO_NM}"),
    ("airplanes.live", f"https://api.airplanes.live/v2/point/{LAT}/{LON}/{RAGGIO_NM}"),
]

# Indirizzo del sito pubblicato: da qui si rilegge lo storico della volta precedente.
SITO_URL = os.environ.get(
    "SITO_URL", "https://carminedavino51-art.github.io/radar-voli-napoli"
).rstrip("/")

CARTELLA_DATI = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "sito", "data")

# I servizi pubblici chiedono di farsi riconoscere con uno User-Agent chiaro.
USER_AGENT = "radar-voli-napoli/1.0 (progetto studente; github.com/carminedavino51-art)"


# --- Funzioni di supporto ----------------------------------------------------

def scarica_json(url, timeout=20):
    """Scarica un URL e restituisce il JSON già convertito in dizionario Python."""
    richiesta = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    with urllib.request.urlopen(richiesta, timeout=timeout) as risposta:
        return json.load(risposta)


def distanza_km(lat1, lon1, lat2, lon2):
    """Distanza in linea d'aria tra due punti (formula di haversine)."""
    r = 6371.0  # raggio medio della Terra in km
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp = math.radians(lat2 - lat1)
    dl = math.radians(lon2 - lon1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * r * math.asin(math.sqrt(a))


def numero(valore, decimali=1):
    """Restituisce il valore arrotondato se è un numero, altrimenti None."""
    if isinstance(valore, bool) or not isinstance(valore, (int, float)):
        return None
    return round(valore, decimali)


def pulisci(aereo):
    """Tiene solo i campi che servono al sito, con nomi in italiano.

    Restituisce None se l'aereo non ha una posizione valida.
    """
    lat, lon = numero(aereo.get("lat"), 5), numero(aereo.get("lon"), 5)
    if lat is None or lon is None:
        return None

    quota = aereo.get("alt_baro")      # in piedi, oppure la stringa "ground"
    a_terra = quota == "ground"

    return {
        "hex": aereo.get("hex", ""),                         # codice ICAO del transponder
        "volo": (aereo.get("flight") or "").strip(),         # es. "RYR5ZQ"
        "reg": aereo.get("r", ""),                           # immatricolazione, es. "EI-GXM"
        "tipo": aereo.get("t", ""),                          # modello, es. "B738"
        "lat": lat,
        "lon": lon,
        "quota_ft": 0 if a_terra else numero(quota, 0),
        "a_terra": a_terra,
        "velocita_kt": numero(aereo.get("gs")),              # velocità al suolo in nodi
        "rotta": numero(aereo.get("track")),                 # direzione in gradi (0 = nord)
        "variometro_fpm": numero(aereo.get("baro_rate")),    # salita/discesa in piedi al minuto
        "squawk": aereo.get("squawk", ""),
        "emergenza": aereo.get("emergency", "none") not in ("none", "", None),
        "dist_km": round(distanza_km(LAT, LON, lat, lon), 1),
    }


def scarica_aerei():
    """Prova le fonti in ordine e restituisce (nome_fonte, lista_aerei_grezzi)."""
    for nome, url in FONTI:
        try:
            dati = scarica_json(url)
            aerei = dati.get("ac") or dati.get("aircraft") or []
            print(f"[ok] {nome}: {len(aerei)} aerei")
            return nome, aerei
        except (urllib.error.URLError, TimeoutError, ValueError) as errore:
            print(f"[!!] {nome} non disponibile: {errore}", file=sys.stderr)
    return None, None


def carica_storico_precedente():
    """Rilegge lo storico già pubblicato sul sito. Se non esiste, si riparte da zero."""
    try:
        storico = scarica_json(f"{SITO_URL}/data/storico.json", timeout=15)
        if isinstance(storico, dict):
            return storico
    except (urllib.error.URLError, TimeoutError, ValueError) as errore:
        print(f"[i] nessuno storico precedente ({errore}), parto da zero")
    return {"punti": [], "visti": {}}


def aggiorna_storico(storico, aerei, adesso_ms):
    """Aggiunge il conteggio di adesso e scarta ciò che è più vecchio di ORE_STORICO."""
    limite = adesso_ms - ORE_STORICO * 3600 * 1000

    punti = [p for p in storico.get("punti", []) if p.get("t", 0) >= limite]
    punti.append({"t": adesso_ms, "n": len(aerei)})

    # "visti" ricorda ogni aereo diverso: codice hex -> [ultima volta visto, nome del volo]
    visti = {h: v for h, v in storico.get("visti", {}).items() if v and v[0] >= limite}
    for a in aerei:
        if a["hex"]:
            visti[a["hex"]] = [adesso_ms, a["volo"]]

    return {"aggiornato": adesso_ms, "punti": punti, "visti": visti}


def salva(nome_file, dati):
    os.makedirs(CARTELLA_DATI, exist_ok=True)
    percorso = os.path.join(CARTELLA_DATI, nome_file)
    with open(percorso, "w", encoding="utf-8") as f:
        json.dump(dati, f, ensure_ascii=False, separators=(",", ":"))
    print(f"[ok] scritto {os.path.normpath(percorso)}")


# --- Programma principale ----------------------------------------------------

def main():
    adesso_ms = int(time.time() * 1000)

    fonte, grezzi = scarica_aerei()
    if grezzi is None:
        # Nessuna fonte ha risposto: usciamo con errore, così GitHub Actions
        # non pubblica nulla e sul sito restano i dati dell'ultima volta.
        print("[!!] tutte le fonti hanno fallito", file=sys.stderr)
        return 1

    aerei = [a for a in (pulisci(x) for x in grezzi) if a is not None]
    aerei.sort(key=lambda a: a["dist_km"])

    salva("voli.json", {
        "aggiornato": adesso_ms,
        "fonte": fonte,
        "centro": [LAT, LON],
        "raggio_km": round(RAGGIO_NM * 1.852),
        "aerei": aerei,
    })

    storico = aggiorna_storico(carica_storico_precedente(), aerei, adesso_ms)
    salva("storico.json", storico)
    return 0


if __name__ == "__main__":
    sys.exit(main())
