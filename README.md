# Markr

En simulering av byutvikling der byen vokser av seg selv. Dette er første steg:
et kart som ser naturlig ut, med et enkelt rutenett i bunn.

## Kjør

Åpne `index.html` i en nettleser. Du trenger ingen server eller byggesteg.

## Hvordan kartet lages

1. **Terreng som kontinuerlige felt** (`src/terrain.js`). Perlin-støy i flere lag
   gir høyde, fuktighet og ulendthet for hvert punkt `(x, y)`. Ulendthet styrer hvor
   mye «ryggstøy» (ridged noise) som legges på høyden. Helning er gradienten til høyden.
2. **Rutenett i indeksrom** (`src/grid.js`). Rute `(i, j)` er alltid enhetskvadratet
   `[i, i+1] × [j, j+1]`. Topologien endres aldri: hver rute har fire naboer, og nettet
   henger alltid sammen.
3. **Deformering til verdensrom.** Hvert hjørnepunkt flyttes mot et vektet snitt av sine
   fire naboer. Vekten er terrengets «tetthet» midt på kanten (høy i bratt terreng). Kanter i
   bratt terreng blir korte, så rutene blir små der, og store i flatt terreng. Med fast,
   konveks yttergrense og positive vekter er dette en Tutte-innbygging, så rutene kan
   aldri brettes eller overlappe.
4. **Bølgete linjer.** En svak, lavfrekvent støyforskyvning gjør linjene mindre rette.
5. **Underruter (kvadtre).** En rute kan deles i fire (`cell.split()`) og slås sammen
   igjen (`cell.merge()`). Underrutene får indeksene `(2i..2i+1, 2j..2j+1)` på neste
   nivå og eier sine egne verdier.

Hver rute har et `values`-objekt med areal, høyde, fuktighet, ulendthet og helning, og
med avledede verdier: jordbruk (stor rute, middels fuktig), byggegrunn (middels stor,
tørrere) og ressurser (små, ulendte ruter).

## Bruk

- Glideren **Indeks ↔ verden** morfer mellom matrisen og det deformerte kartet.
- **Visning** bytter mellom terreng, høyde, fuktighet, ulendthet, helning, rutestørrelse,
  jordbruk, byggegrunn og ressurser.
- Klikk deler en rute i fire. Høyreklikk slår sammen igjen. Dra for å panorere, bruk
  hjulet for å zoome.
