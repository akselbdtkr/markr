# Markr

En simulering av byutvikling der byen vokser av seg selv. Dette er første steg:
et kart som ser naturlig ut, med et enkelt rutenett i bunn.

## Kjør

Åpne `index.html` i en nettleser. Du trenger ingen server eller byggesteg.

## Hvordan kartet lages

1. **Terreng som kontinuerlige felt** (`src/terrain.js`). Alle mål er i meter. Perlin-støy
   i flere lag gir høyde, fuktighet og ulendthet for hvert punkt `(x, y)`. Støyen bruker en
   heltallshash i stedet for en permutasjonstabell, så den gjentar seg aldri.
   - **Landskap i lag.** Landskapet bygges av fire lag, alle sett gjennom en svak forvrengning
     (domain warp) så kyster og fjellkjeder bøyer seg naturlig. Bølgelengdene er korte, så
     noen få kilometer viser litt av hvert:
     - *Kyst* (9 km): land der kontinentlaget ligger over kystnivået. Havbunnen faller av
       fra kysten, og landet stiger sakte innover.
     - *Slette eller åser* (2,5 km): glir mykt over i hverandre. Åser er litt høyere og mer
       kuperte.
     - *Platå* (10 km): et eget lag, så store områder kan ligge på et platå. Platået hever
       landet 500–800 m og er jevnt på toppen. Hvor bratt kanten er, varierer (2,5 km
       støy): bratt som en gammel kystlinje noen steder, en myk overgang til åsene andre
       steder. Når et platå når havet, blir kysten bratt.
     - *Fjell* (4,5 km): sammenhengende, forgrenede kjeder (ridged-støy). Topper og skar kommer
       fra rygger sentrert om sitt snitt. Fjell kan ligge på et platå eller utenfor.
   - **Innstillinger.** Under *Generering → Landskap* stiller man havnivå, overgangen slette |
     åser, platånivå, fjellnivå og landskapsskala. Andelen av hver type vises. Standard er
     omtrent 30 % hav, 25 % slette, 30 % åser, 12 % platå og 2–3 % alpint.
   - **Start.** Kartet åpner der et lite område har flest landskapstyper og litt hav.
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
     og er hav hvis den er under 0 m. Seksjonene grupperes i blokker på 4 × 4 seksjoner (2 km).
     Et steg mellom to blokker koster 1, pluss et tillegg for stigning og for høyt terreng.
     Hver blokk finner den billigste veien til en blokk med hav (Dijkstra fra blokken selv,
     så svaret er eksakt og det samme for alle som spør), og drenerer til naboen med lavest
     stegkostnad pluss videre kostnad. Inne i blokken går hver seksjon til naboen med den
     billigste veien videre til blokkens utløp, eller til havet. Kostnaden synker for hvert
     steg, så nettet har ingen løkker. Vannet fra en blokk samles i ett utløp, og elvene går
     rundt fjell når det er billigere enn å gå over dem. Nettet bygger bare på grove verdier,
     så hver seksjon kan regne det ut selv, uavhengig av rekkefølgen spilleren utforsker i.
   - **Kryssingspunkt.** Vannet går over til nabo-seksjonen der en dal krysser den felles
     kanten: den dypeste forsenkningen under den rette linja mellom endene, innenfor den
     midterste halvdelen av kanten. Det laveste punktet alene lå nesten alltid i et hjørne,
     og da rant elvene langs seksjonskantene. Utløp mellom blokker velges på samme måte.
   - **Kilder.** Antallet kilder avhenger av landskapstypen: alpint og åser får flest,
     sletter og platåer få, så vannet der samles i færre og større elver.
   - **Inne i seksjonen.** Vassdraget som kommer inn ovenfra, går først. Det bærer med seg
     nedbørfeltet sitt. Så kommer seksjonens egne kilder, de høyeste punktene holdt minst 8
     ruter fra hverandre. Alle passerer et vendepunkt før utløpet: litt til siden for den
     rette linja og flyttet til lavest terreng i nærheten. Der møtes de, og løpet svinger. Hvert
     steg går til en nabo som er nærmere målet. I bratt terreng vinner laveste nabo. Der det er
     flatere, vurderes naboene etter terrenget sett i blokker på 2, 4, 8 og 16 ruter (glattet
     mellom blokksentrene), og en fast slyngning per punkt hindrer rette løp.
   - **Deltaer.** Der en stor elv kommer inn i en havseksjon, deler den seg i opptil tre
     løp mot hvert sitt punkt i havkanten. På sletter som drenerer rett ut i en havseksjon,
     begynner deltaet halvparten av gangene allerede der: elva deler seg i tre løp som sprer
     seg over seksjonen. Elvevann og grunt hav har samme farge, så elv og hav møtes uten skjøt.
   - **Virkning.** Bekken gjør landet brattere (som gir mindre ruter) og våtere, i et bånd på
     tvers av løpet like bredt som skalaen.
   - **Rutene eier vassdraget.** Hver grunnrute som bekkelinja krysser, lagrer biten av
     bekken som går gjennom den: hvor den går inn og ut (i rutas egne u,v-koordinater),
     størrelse, skala og retning. Vassdraget vises som en farge i rutene: en bekk farger en
     stor rute svakt, en elv fyller den.
   - **Blanding og bølger.** Der naboruter har stor fargeforskjell (kyst, elv, overgang mellom
     soner), får hvert hjørne snittfargen av rutene rundt seg, og ruta tegnes i små biter som
     glir fra sin egen farge mot hjørnenes. Det gir en myk kystlinje. I vannet nær land går en
     svak, animert puls inn mot kysten, som bølger. Rutene tegnes i et fast lag som bare
     tegnes på nytt når utsnittet endres; bølgene og musmarkøren legges oppå.
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
