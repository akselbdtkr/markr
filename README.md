# Markr

En simulering av byutvikling der byen vokser av seg selv. Dette er første steg:
et kart som ser naturlig ut, med et enkelt rutenett i bunn.

## Kjør

Åpne `index.html` i en nettleser. Du trenger ingen server eller byggesteg.

## Hvordan kartet lages

1. **Terreng som kontinuerlige felt** (`src/terrain.js`). Alle mål er i meter. Perlin-støy
   i flere lag gir høyde, fuktighet og ulendthet for hvert punkt `(x, y)`. Støyen bruker en
   heltallshash i stedet for en permutasjonstabell, så den gjentar seg aldri.
   - **Landskapslag per seksjon.** Hver seksjon (512 m) får en typeverdi fra Perlin-støy, fra
     marin (0) via slette, åser og platå til alpin (1), og en retning fra et annet støylag.
     Typeverdien blandes mellom seksjonssentrene. Inne i hver seksjon hever retningen typen på
     den ene siden og senker den på den andre (null ved seksjonskanten, så feltet henger
     sammen), så en grense mellom for eksempel marin og slette kan gå midt i en seksjon.
   - **Hva typene gjør:** marin gir mye under 0 m, slette er jevn og lav, åser er småkupert,
     platå er jevnt men høyt, alpint er høyt med fjellrygger. Hver type har et ganske flatt
     høydebånd; overgangene mellom typene er der landet stiger.
   - **Ulendthet** (egen støy, 2,5 km og 600 m) skalerer relieffet uavhengig av typen og
     lager anomalier: bratte partier og skjær i marint og på sletter, flatere partier i alpint.
   - **Høyde** går fra −5000 til 5000 m. Omtrent 85 % ligger mellom −100 og 1000 m.
   - **Vann:** alt under 0 m er vann, har 100 % fuktighet og er flatt.
   - **Tregrense ved 1000 m:** grønnfargen forsvinner mellom 850 og 1000 m.
   - **Fuktighet:** naturlig fuktighet holder seg under 90 %. Vassdrag gjør landet rundt
     våtere. Fargen går fra tørr via grønn mot blå, og ved 100 % er ruta helt blå.
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
7. **Vassdrag.** Alle vassdrag ender i havet.
   - **Nett mellom seksjoner.** Hver seksjon får en grov høyde (terrenget midt i seksjonen),
     og er hav hvis den er under 0 m. Hver seksjon finner avstanden til nærmeste
     havseksjon. Den drenerer til den laveste av de fire naboene som ligger nærmere havet.
     Hvert steg kommer nærmere havet, så alle kjeder ender der. Nettet bygger bare på disse
     grove verdiene, så hver seksjon kan regne det ut selv, uten å kjenne rutene i andre
     seksjoner, og uavhengig av rekkefølgen spilleren utforsker i.
   - **Kryssingspunkt.** Vannet går over til nabo-seksjonen i det laveste punktet langs den
     felles kanten, prøvd direkte fra terrenget. Begge seksjonene får samme svar.
   - **Inne i seksjonen.** Vassdraget som kommer inn fra seksjonene oppstrøms, går først. Det
     bærer med seg nedbørfeltet sitt: alle kildene oppstrøms. Så kommer seksjonens egne
     kilder, de høyeste punktene holdt minst 8 ruter fra hverandre, som teller 1 hver. Alle
     går mot seksjonens utløp, så de møtes og følger samme løp videre. Hvert steg går til en
     nabo som er nærmere utløpet. I bratt terreng vinner laveste nabo. Der det er flatere,
     vurderes naboene etter snittet i blokker på 2, 4, 8 og 16 ruter, og en fast slyngning
     per punkt hindrer rette løp. I en havseksjon slutter vassdraget ved første vann.
   - **Virkning.** Bekken gjør landet brattere (som gir mindre ruter) og våtere, i et bånd på
     tvers av løpet like bredt som skalaen.
   - **Rutene eier vassdraget.** Hver grunnrute som bekkelinja krysser, lagrer biten av
     bekken som går gjennom den: hvor den går inn og ut (i rutas egne u,v-koordinater),
     størrelse, skala og retning. Bekken tegnes som en tekstur på ruta. Er kanalen bred nok
     i forhold til ruta, får ruta 100 % fuktighet og blir blå.
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
