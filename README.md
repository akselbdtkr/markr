# Markr

En simulering av byutvikling der byen vokser av seg selv. Dette er første steg:
et kart som ser naturlig ut, med et enkelt rutenett i bunn.

## Kjør

Åpne `index.html` i en nettleser. Du trenger ingen server eller byggesteg.

## Hvordan kartet lages

1. **Terreng som kontinuerlige felt** (`src/terrain.js`). Alle mål er i meter. Perlin-støy
   i flere lag gir høyde, fuktighet og ulendthet for hvert punkt `(x, y)`. Støyen bruker en
   heltallshash i stedet for en permutasjonstabell, så den gjentar seg aldri, og terrenget
   finnes i alle retninger.
   - **Høyde** går fra −5000 til 5000 m. Grunnformen er normalfordelt (snitt 400 m,
     standardavvik 480 m), så omtrent 65 % av kartet ligger mellom −100 og 1000 m.
     Ulendthet skalerer alle relieff-lagene: fjellrygger (bølgelengde 7 km), åser (900 m)
     og småterreng (110 m).
   - **Vann:** alt under 0 m er vann, har 100 % fuktighet, er flatt og farges blått etter dybde.
   - **Tregrense ved 1000 m:** grønnfargen forsvinner mellom 850 og 1000 m. Over det er det
     snaufjell, og over omtrent 2000 m snø.
2. **Rutenett i indeksrom** (`src/grid.js`). Rute `(i, j)` er alltid enhetskvadratet
   `[i, i+1] × [j, j+1]`, og én indeksenhet er 16 m. Topologien endres aldri: hver rute har
   fire naboer, og nettet henger alltid sammen.
3. **Deformering til verdensrom.** Hvert hjørnepunkt flyttes mot et vektet snitt av sine
   fire naboer. Vekten er terrengets «tetthet» midt på kanten (høy i bratt terreng). Kanter i
   bratt terreng blir korte, så rutene blir små der, og store i flatt terreng og på åpent vann.
   Med fast, konveks yttergrense og positive vekter er dette en Tutte-innbygging, så rutene
   kan aldri brettes eller overlappe.
4. **Bølgete linjer.** En svak, lavfrekvent støyforskyvning gjør linjene mindre rette.
5. **Underruter (kvadtre).** En grunnrute på 16 m kan deles i fire ruter på 8 m, og videre til
   4, 2 og 1 m (`cell.split()`). Den kan slås sammen igjen (`cell.merge()`). Underrutene får
   indeksene `(2i..2i+1, 2j..2j+1)` på neste nivå og eier sine egne verdier. Grunnrutene er
   den groveste enheten, så de slås aldri sammen med hverandre. Deling skjer etter areal
   (auto-del) eller når spilleren klikker. Senere skjer den også når noe bygges.

Hver rute har et `values`-objekt med areal (m²), høyde (moh.), fuktighet, ulendthet og helning,
og med avledede verdier: jordbruk (stor rute, middels fuktig, under tregrensen), byggegrunn
(middels stor, tørrere) og ressurser (små, ulendte ruter).

## Bruk

- Glideren **Indeks ↔ verden** morfer mellom matrisen og det deformerte kartet.
- **Visning** bytter mellom terreng, høyde, fuktighet, ulendthet, helning, rutestørrelse,
  jordbruk, byggegrunn og ressurser.
- **Oversikt** tegner terrenget rundt utsnittet (3–300 km). Klikk der for å lage rutenett et
  annet sted, eller flytt med V/N/S/Ø.
- Klikk deler en rute i fire. Høyreklikk slår sammen igjen. Dra for å panorere, bruk
  hjulet for å zoome.
