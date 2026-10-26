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
2. **Rutenett i indeksrom** (`src/world.js`). Rute `(i, j)` er alltid enhetskvadratet
   `[i, i+1] × [j, j+1]`, og én indeksenhet er 16 m. Topologien endres aldri: hver rute har
   fire naboer, og nettet henger alltid sammen. Indeksene kan være hvilke som helst heltall.
3. **Deformering til verdensrom.** Hvert hjørnepunkt flyttes mot et vektet snitt av sine
   fire naboer. Vekten er terrengets «tetthet» (høy i bratt terreng og langs bekker). Rutene
   blir små i bratt terreng og store i flatt terreng og på åpent vann.
4. **Seksjoner med faste sømmer.** Kartet deles i seksjoner på 32 × 32 ruter (512 m). Hver søm
   mellom to seksjoner løses for seg, i en stripe med *sømbuffer* ruter på hver side, bare ut
   fra terrenget. Hjørnene der fire seksjoner møtes løses på samme måte. Begge seksjonene bruker
   samme søm som fast kant. Dermed er hver seksjon en ren funksjon av frøet og plasseringen:
   - Den ser lik ut hver gang, uansett i hvilken rekkefølge spilleren kommer dit.
   - Ingenting om rutenettet må lagres. Bare spillerens endringer (delinger) lagres.
   - Seksjoner lages når de kommer i bildet, nærmest midten først. De som ikke er i bruk,
     slippes fra minnet og kommer tilbake identiske.
5. **Bølgete linjer.** En svak, lavfrekvent støyforskyvning gjør linjene mindre rette.
6. **Vannlinja.** Hver rute er enten land eller vann, så kysten går alltid langs rutesider.
   Hjørnepunktene på grensen mellom land og vann flyttes inn på 0 m-koten (Newton-steg langs
   gradienten, begrenset til halve korteste kant), så kysten blir glatt.
7. **Vassdrag.** Hver seksjon har noen få kilder: det høyeste punktet, deretter det nest høyeste
   som ikke er nabo med et valgt punkt, og så videre. Fra hver kilde følger bekken bratteste
   lavere nabo på et fast 16 m-gitter i verdensrommet, til den når 0 m. En grop fylles som en
   innsjø til vannet finner et lavere utløp. Når to bekker møtes, gjenbrukes resten av banen.
   En bekk er høyst *maks lengde* ruter lang, så bare kilder innenfor den avstanden kan nå en
   seksjon. Dermed er vassdragene også lokale og deterministiske. Ruta en bekk krysser blir
   brattere, naboene halvparten så mye, og flere bekker gir større effekt. Det trekker små
   ruter langs vassdragene.
8. **Underruter (kvadtre).** En grunnrute på 16 m kan deles i fire ruter på 8 m, og videre til
   4, 2 og 1 m (`cell.split()`). Den kan slås sammen igjen (`cell.merge()`). Underrutene får
   indeksene `(2i..2i+1, 2j..2j+1)` på neste nivå og eier sine egne verdier. Grunnrutene er den
   groveste enheten og slås aldri sammen med hverandre. Deling skjer etter areal (auto-del)
   eller når spilleren klikker, og senere også når noe bygges.

Hver rute har et `values`-objekt med areal (m²), høyde (moh.), fuktighet, ulendthet og helning,
antall bekker som krysser ruta, og avledede verdier: jordbruk (stor rute, middels fuktig, under tregrensen), byggegrunn
(middels stor, tørrere) og ressurser (små, ulendte ruter).

## Bruk

- Glideren **Indeks ↔ verden** morfer mellom matrisen og det deformerte kartet.
- **Visning** bytter mellom terreng, høyde, fuktighet, ulendthet, helning, rutestørrelse,
  jordbruk, byggegrunn og ressurser.
- Dra i kartet for å bevege deg. Kartet fortsetter i alle retninger.
- **Oversikt** tegner terrenget rundt det du ser (3–300 km). Klikk der for å hoppe, eller flytt
  med V/N/S/Ø.
- **Vis seksjonsgrenser** viser sømmene mellom seksjonene.
- Klikk deler en rute i fire. Høyreklikk slår sammen igjen. Dra for å panorere, bruk
  hjulet for å zoome.
