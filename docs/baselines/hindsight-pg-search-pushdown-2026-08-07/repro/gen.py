import random, sys, uuid, io

random.seed(20260807)

# Anonymised live bank-size distribution (memory_units row counts, 2026-08-07).
BANKS = [("bank-01",232382),("bank-02",227175),("bank-03",86500),("bank-04",86338),
         ("bank-05",81969),("bank-06",43761),("bank-07",18145),("bank-08",10716),
         ("bank-09",8957),("bank-10",1525),("bank-11",190),("bank-12",157),
         ("bank-13",66),("bank-14",12)]
FACT_TYPES = [("world",0.6092),("experience",0.2026),("observation",0.1882)]

V = 20000
VOCAB = [f"tk{i:05d}" for i in range(V)]
# Zipf-ish weights
W = [1.0/((i+1)**0.85) for i in range(V)]
CUM = []
s = 0.0
for w in W:
    s += w
    CUM.append(s)
TOT = s

import bisect
def pick():
    return VOCAB[bisect.bisect_left(CUM, random.random()*TOT)]

def words(n):
    return " ".join(pick() for _ in range(n))

out = sys.stdout
for bank, n in BANKS:
    for _ in range(n):
        r = random.random()
        acc = 0.0
        ft = "world"
        for name, p in FACT_TYPES:
            acc += p
            if r <= acc:
                ft = name
                break
        rid = str(uuid.UUID(int=random.getrandbits(128), version=4))
        out.write(f"{rid}\t{bank}\t{ft}\t{words(31)}\t{words(2)}\t{words(4)}\n")
