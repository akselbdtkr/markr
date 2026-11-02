# Markr

En simulering av byutvikling der byen vokser av seg selv. Dette er første steg:
et kart som ser naturlig ut, med et enkelt rutenett i bunn.

## Kjør

Åpne `index.html` i en nettleser. Du trenger ingen server eller byggesteg.

## Rutelab

`lab.html` er en egen testside for et rutenett som følger terrenget bedre, på et lite kart
(8 × 8 seksjoner à 8 × 8 ruter, omtrent 1 km). Den viser høydekurver, rutenettet,
seksjonsgrenser, brettede ruter og retningsfeltet, og måler hvor godt rutene følger
høydekurvene.

- **Retningsfelt** (`src/fieldgrid.js`): fra høydene lages et kryssfelt som viser retningen
  langs høydekurvene. Det lagres som vinkelen ganger fire, siden en rute ser lik ut dreid
  90°, og glattes slik at tydelige linjer holder og flate områder tar retning fra omgivelsene.
- **Rutenett**: hver kant får en ønsket retning og lengde fra feltet (dreid etter kurvene,
  kortere i bratt terreng), og hjørnene legges så alle kantene passer best mulig samlet. Når
  én kant roterer, drar den naboene med seg. Et svakt anker trekker hjørnene mot det rette
  rutenettet.
- **Seksjoner**: hver seksjon kan løses for seg med en buffer rundt, uten faste sømmer.

Målt på frø 1848: avviket fra høydekurvene går fra 24° (rett rutenett) til omtrent 17–18°,
med 2 brettede ruter. Løst seksjon for seg er sømmene 3–10 m, avhengig av buffer og anker.

## Grunnlagene

`grunn.html` viser de største lagene alene (`src/baselayer.js`). Terrenget skal bygges lag
for lag: grunnforskyvning → mellomlag → områdelag (fasthet, landskapstype, nedsenk) →
lokalt terreng. Hvert lag arver fra laget over.

### Grunnforskyvning (100–500 km)

- **Av/på:** hvert lag kan skrus av og på uten å endre verdiene, og øyet viser laget alene.
- **Verdi:** tre fbm-lag blandes etter vekt: kontinenter (2400 km), havbasseng (1008 km) og
  grunnlaget (240 km). Størrelse og vekt skrives inn for hvert lag.
- **Sund:** ridged noise (144 km) gjør lavland nær kysten til åpent hav, så havbassenger
  knyttes sammen. Sundene skjærer aldri gjennom høyland.
- **Innland:** verdien deles i en stor del (kontinenter og første oktav av havbassenget) og
  detaljer (resten av havbassenget og grunnlaget). Der den store delen ligger over
  innlandsterskelen (stiplet strek i profilen), er detaljene vektet positivt: de legger til
  fritt, men trekker aldri landet under havterskelen. Sund virker ikke der. Slik oppstår
  ikke hav som små sjøer inne i et kontinent.
- **Terskler:** hav | lavland | høyland | vanndeling, på samme verdi. Profilen viser høyden
  etter verdien, med andelen av kartet bak i flate klassefarger. Strekene under dras.

### Mellomlaget

- **Arver fra grunnlaget:** det flytter verdien bare på land, økende fra kysten og innover.
  Det er vektet positivt: det kan løfte fritt, men aldri senke landet under havterskelen,
  så det lager ikke sjøer.
  Kysten blir der grunnlaget satte den, mens høyland og vanndeling løftes eller senkes, så
  noen fjellområder blir høye og andre lave.
- **Strukket langs helningen, lokalt** (`stretched` i `src/baselayer.js`, gjenbrukes for
  nedsenk-laget):
  - Den glatte delen av grunnlaget (kontinenter og havbasseng, to oktaver) deles i nivåer
    med fast avstand ΔB.
  - Fra et punkt tas ett Newton-steg langs helningen ned til nivået under og ett opp til
    nivået over. Støyen leses der, og de to blandes etter hvor punktet ligger mellom
    nivåene.
  - Alle punkter på samme helningslinje mellom to nivåer leser samme sted. Laget jevnes
    da ut langs helningen og varierer fullt på tvers. Nivålinjene bøyer seg med
    grunnlaget, så dragene gjør det også.
- **Grenser:** steget er bare riktig så lenge helningen holder retningen.
  - Det begrenses mykt til en firedel av havbassenget og til halve krumningsradiusen der
    punktet står, og avtar der grunnlaget er nesten flatt.
  - Uten grensene oppstår bretter, skarpe kanter der nabopunkter lander på samme sted.
  - Målt strekking (endring på tvers delt på endring langs) er ca. 1,5 med 185 km bredde
    og ca. 1,8 med 60 km.

### Områdelagene (`src/regionlayer.js`, 50–100 km)

Lagene arver høyden og helningen fra grunnlaget, og strekkes langs helningen som
mellomlaget. Retningen i et punkt regnes én gang og deles av alle strukne lag.

- **Fasthet (0–1):** arves fra grunnlaget, der lavland er løsere enn høyland, pluss eget
  noise-lag. En S-kurve gir gradvis overgang.
- **Landskapstype:** slette, åser, platå og fjellsk ligger på én kjede ordnet etter fasthet.
  Typelaget avgjør hvor i kjeden et område ligger, og fastere grunn og høyere land flytter
  det videre mot fjellsk. I hvert nabopar gir fastere grunn den neste typen. Typene glir
  over i hverandre, og hver har sin farge på kartet. Typeverdien leses med tre terskler som
  du setter selv i en egen profil: slette | åser | platå | fjellsk. Hver terskel er en
  S-kurve med justerbar bredde («Overgang»). Der kurvene overlapper, er et punkt en andel
  av flere typer. Profilen viser andelen av hver type som en kurve i typens farge.
- **Fuktighet:** regnes fra type og fasthet. Løse sletter er våte, faste fjell er tørre.

### Nedsenkslaget (`src/depressionlayer.js`)

Et bånd der et strukket noise-lag passerer en midtverdi, senker landet mot grunnforskyvningen
(grunnverdien uten mellomlaget, minus en dybde). Inne i båndet jevnes mellomlaget nesten
ut. Nær kysten kan bunnen gå under havterskelen og bli fjord. Innenfor innlandsterskelen
kan den ikke det, så det blir ikke innlandssjøer.

- **To metoder, valgt med knapp:**
  - **Medianterskel:** båndet ligger der en strukket fbm passerer medianen (0). Linjene er
    lange og buktende, og de krysser eller forgreiner seg aldri.
  - **Ridged:** linjer fra to oktaver, der den andre er halvparten så stor, smalere og
    grunnere. Linjene møtes og krysser, så det blir grener, men også løkker.
- **Fasthet:** løs grunn gir bredere bånd med flat bunn og bratte sider. Fast grunn gir
  smale bånd med myke, V-formede sider.
- **Linjebredde og myke kanter:** bredden på båndet og hvor langt S-kurven går ut fra
  linja kan justeres hver for seg.
- **Retning:** deler av båndet som går på tvers av helningen, blir grunne. Dype,
  sammenhengende nedsenkninger går derfor med helningen.

### Elvene (`src/riverline.js`)

Elvene regnes punkt for punkt, men alt leses i bunnen av snittet. Bunnen er linja der
nedsenk-støyen er 0. Fra et punkt gir ett Newton-steg på tvers bunnpunktet, og avstanden dit.
Alle punkter i samme snitt finner samme bunnpunkt, så begge breddene får samme bredde og
vannflate.

- **Hvor:** bare der båndet går med helningen, på land og under vanndelingsfeltet. Elva avtar
  med en S-kurve når båndet dreier bort. Den avtar raskt i fast fjellsk og i løse sletter og
  platåer, og mykere i åser og i løst lavland og høyland.
- **Bredde:** fra fasthet (løs grunn gir bredere elv) og høyde over havet (høyere opp er den
  smalere, lenger ned bredere).
- **Vannflate:** fra den store delen av grunnlaget i bunnpunktet. Den stiger jevnt oppover
  helningen, så vannflaten faller jevnt nedover elva.
- **Flere løp nær havet:** korridoren blir bredere, og et lite strukket noise-lag deler den i
  flere løp med øyer imellom. Hovedløpet blir smalere.
- **Området rundt:** landet skråner ned mot vannet i en sone som er bredere i løs grunn, og
  som varierer med et sakte noise-lag.

Nedsenkslaget trekker bunnen hardt mot havnivå i lavland («Mot havnivå»), og ekstra i
sletter. Lavland leses fra den store, glatte delen av grunnlaget, så trekket holder langs hele
nedsenket. Havet følger da nedsenkene langt inn: fjorder, øyer og små sund. I lavland er
båndet fyllere, og retningen teller mindre, så det brytes ikke opp. Innlandsgrensen gir etter
i samme grad. Elvene ligger lavt: vannflaten beholder bare en andel («Høyde beholdt») av
høyden over havet, og lavlandet trenger mindre retning for å holde elva sammen.

**Målestokk:** simuleringen har sine egne enheter. På skjermen er én enhet 1/50 m
bortover og 1/10 m i høyden (justerbart: «Målestokk 1:» og «Høyde 1:»). Laget er laget i stor
skala, men spillet skal spilles i utsnitt på 2 km til 100 m, så kontinentene blir ca. 60 km,
dalene noen hundre meter og fjellene noen hundre meter høye. Størrelser i panelet vises i
skjermens km og m. En rute på 16 m er 800 enheter.

**Oppløsning:** kartet trenger aldri finere detalj enn punktene det tegner (høyst rutene på
16 m). Mellomlaget, områdelagene og nedsenkslaget varierer langsomt. De regnes derfor på et
grovt rutenett av noder med en rute (16 m) ganget med en toerpotens, lagres
på tvers av tegninger og blandes kubisk (Catmull-Rom), så skygger ikke viser rutenettet.
De glatte lagene bruker en sekstendedel av lagets størrelse. Nedsenkslaget har smale renner
og følger punktene som tegnes. Hele kartet tegnes på ca. 0,6 s.

**På siden:** alle seksjonene er lukket fra start. Kartet kan vises i farger eller i
gråtoner med kraftigere skygge. Lyset kommer alltid fra øverst til venstre. Høydekurver,
omriss av vanndelingsfelt og stiplede blå omriss av nedsenksfelt er av som standard og kan
skrus på. Høydekurver hver 100 m (mørkere hver 500 m) kan skrus av og på. «Kopier
innstillinger» kopierer alle verdiene, og hvilke lag som er på, som tekst til chatten.

## Ruteformler

`formel.html` regner rutenettet med lokale formler: én for hver rute (3 × 3 høyder gir
helning, krumning, egg, dal, topp, bunn og kyst) og én for hvert hjørne (rad- og
kolonnesummer med hopp, terskler som S-kurver). Alt er lokalt, så hver seksjon kan regnes
for seg uten sømmer. Kantene på rutene følger konturen, aldri diagonalen.

### Elver og bekker (`src/riverlayer.js`, `src/rivers.js`)

Elvene regnes **før** rutene, og rutene formes etter dem. Alle vassdrag er vann og farger
rutene de ligger i blå; de tegnes ikke som linjer.

- **Store elver fra et eget noise-lag.** En elvelinje er der et vridd noise-lag krysser null.
  Fra et punkt på linja følges den i steg på 256 m begge veier. Nedstrøms er den veien som
  når havet (ellers den som ender lavest). Oppstrøms må den nå ulendt og høyt terreng
  (over «Elva starter i ulendt terreng over»): en elv kan ikke starte på flatt land.
- **Hele løpet lastes billig.** Vandringen bruker bare noise og grov terrenghøyde, ingen
  seksjoner eller ruter. Den huskes per punkt, så andre punkter på samme elv gjenbruker den.
  Slik vet en seksjon at den har en elv selv om kilden ligger langt unna.
- **Vannflaten** ligger ikke på 0 m. Den faller jevnt fra høyden der elva starter til der
  den slutter: `hStart + (hSlutt − hStart) · oppstrøms / (oppstrøms + nedstrøms)`.
- **Bredde og dybde** uten nedbørfelt: bredden kommer av fastheten (løs grunn gir bred elv)
  og hvor flatt det er, og vokser mot munningen, fra 8 m opp til 1 km. Dybden kommer av
  elveløpets formel, dypere i fast grunn. Elva graves ned i høyden, med bredder som stiger
  brattere i fast grunn.
- **Fasthet** er to S-kurver med gradvis overgang: høyt og tørt er fast, lavt og vått er løst.
- **Bekker** starter i dalhoder (S-kurve for helning, med avstand mellom kildene) og følger
  bratteste vei ned til hav, elv eller en annen bekk. Volumet trenger ikke stemme med elva.
  En grop fylles lokalt (inntil 40 ruter) og blir en innsjø hvis den er dypere enn
  terskelen. Bekkene trenger bare seksjonen og én seksjon rundt.

## Hvordan kartet lages

1. **Terreng som kontinuerlige felt** (`src/terrain.js`). Alle mål er i meter. Perlin-støy
   i flere lag gir høyde, fuktighet og ulendthet for hvert punkt `(x, y)`. Støyen bruker en
   heltallshash i stedet for en permutasjonstabell, så den gjentar seg aldri.
   - **Landskap i lag.** Landskapet bygges av fire lag, alle sett gjennom en svak forvrengning
     (domain warp) så kyster og fjellkjeder bøyer seg naturlig. Bølgelengdene er korte, så
     noen få kilometer viser litt av hvert:
     - *Kyst*: hav og kontinenter (80 km) avgjør hvor de store havene ligger. Et nett av
       sund (ridged-støy, 150 km) senker landet langs sammenhengende linjer, så havene
       knyttes sammen. Kystlinja (9 km) gir detaljene. Land er der verdien ligger over
       kystnivået. Havbunnen faller av fra kysten, og landet stiger sakte innover.
     - *Slette eller åser* (2,5 km): glir mykt over i hverandre. Åser er litt høyere og mer
       kuperte.
     - *Platå* (10 km): et eget lag, så store områder kan ligge på et platå. Platået hever
       landet 500–800 m og er jevnt på toppen. Hvor bratt kanten er, varierer (2,5 km
       støy): bratt som en gammel kystlinje noen steder, en myk overgang til åsene andre
       steder. Når et platå når havet, blir kysten bratt.
     - *Fjell* (4,5 km): sammenhengende, forgrenede kjeder (ridged-støy). Topper og skar kommer
       fra rygger sentrert om sitt snitt. Fjell kan ligge på et platå eller utenfor.
   - **Landskapsområder.** Et eget støylag på 100 km (to verdier) plasserer hvert punkt mellom
     fem områder. Hvert område er et sett innstillinger for lagene over, og innstillingene
     blandes med myke vekter, så områdene glir over i hverandre:
     - *Blandet kyst*: harde kyster med klipper, sletter, åser, platåer og fjell.
     - *Fjordland*: store, høye platåer og fjell, med daler som skjæres ned under havnivå nær
       kysten og blir fjorder.
     - *Innsjøland*: lave, myke åser med mange innsjøer, fuktig og mange bekker.
     - *Deltasletter*: flatt lavland, svært grunt hav og store deltaer.
     - *Skjærgård*: mange små sund, en grunn sokkel der platåene ligger under vann, og fjell
       som reiser seg rett fra havet.
     Områdene styrer også hvor mange kilder seksjonene får, hvor ofte elvene deler seg i
     deltaer, og fuktigheten. Visningen *Landskapsområde* viser dem, og i menyen kan man velge
     ett område for hele kartet.
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
6. **Vannlinja og høydekurver.** Hver rute legges i et høydebånd: vann er ett bånd, og land
   deles i bånd for hver 100. meter (innstillingen *Følg høydekurver*). Et hjørnepunkt der
   bånd møtes, flyttes mot høydekurven mellom dem (Newton-steg langs gradienten, høyst halve
   korteste kant). Da snur rutene rundt seg, så en side følger kurven: rotasjonen kommer av at
   hjørnene flyttes, og hver rute viser sin rotasjon i panelet. Ved kysten flyttes punktene
   helt inn på 0 m-koten, så kysten går langs rutesider og blir glatt. Inne på land flyttes de
   bare halvveis, og bare der det er bratt nok til at linja er tydelig. Der en kurve krysser
   rutenettet på skrå, ville full flytting bøyd rutene til kiler.
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
     sletter og platåer få, og mange seksjoner får ingen kilde i det hele tatt. Vannet samles
     i færre og større elver.
   - **Vann renner ikke oppover.** Langs hvert løp holdes vannstanden på det laveste den har
     vært. Rutene elva krysser etterpå, senkes til den høyden, som en kanal skåret gjennom
     terrenget. Ved en seksjonsgrense starter løpet på den laveste siden av kryssingspunktet.
   - **Synlighet.** Nærmest kilden ser man bare elvas spor i landskapet: brattere og våtere
     terreng og mindre ruter. Fargen tones inn når bekken har rent et stykke (160–640 m)
     eller fått tilsig fra en annen.
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
     størrelse, skala, retning og hvor mange meter vannet faller gjennom ruta. Når du zoomer
     inn, tegnes vassdraget som et bånd langs løpet inne i rutene: helt vann i kanalen, og en
     S-kurve som raskt blir tørrere mot sidene. Der vannet faller bratt, blir båndet hvitt, som
     fosser og stryk. Langt ute farger vassdraget hele ruta svakt.
   - **Blanding og bølger.** Der naboruter har stor fargeforskjell (kyst, elv, overgang mellom
     soner), får hvert hjørne snittfargen av rutene rundt seg, og ruta tegnes i små biter som
     glir fra sin egen farge mot hjørnenes. Jo nærmere du zoomer, jo flere biter, så blandingen
     holder seg myk. I havet nær land går en svak, langsom puls inn mot kysten, som bølger.
     Innsjøer har ingen bølger. Rutene tegnes i et fast lag som bare
     tegnes på nytt når utsnittet endres; bølgene og musmarkøren legges oppå.
8. **Underruter (kvadtre).** En grunnrute på 16 m kan deles i fire ruter på 8 m, og videre til
   4, 2 og 1 m (`cell.split()`). Den kan slås sammen igjen (`cell.merge()`). Underrutene får
   indeksene `(2i..2i+1, 2j..2j+1)` på neste nivå og eier sine egne verdier. Grunnrutene er den
   groveste enheten og slås aldri sammen med hverandre. Deling skjer etter areal (auto-del)
   eller når spilleren klikker, og senere også når noe bygges.

Hver rute har et `values`-objekt med areal (m²), høyde (moh.), fuktighet, ulendthet og helning,
antall bekker som krysser ruta, og avledede verdier: jordbruk (stor rute, middels fuktig, under tregrensen), byggegrunn
(middels stor, tørrere) og ressurser (små, ulendte ruter).

## Kartet

Kartet vokser rundt spilleren: seksjonene i og rett rundt utsnittet genereres, nærmest
midten først, i Web Workers i bakgrunnen, så siden svarer mens kartet fylles inn. Åpnes
siden rett fra disk, der nettleseren ikke tillater workers, lages seksjonene på siden, én
per bilde. Utsnittet er fra 100 m til 10 km bredt (20 × 20 seksjoner), og starter på 2 km.
I minnet holdes det videste utsnittet og en margin; seksjoner som slippes, kommer tilbake
identiske. Langt ute tegnes hver seksjon fra et bilde som lages én gang.

## Kamera

Kameraet styres med musepekeren. I et tynt bånd langs kanten av kartet (en tiendedel av
avstanden fra midten, målt i utsnittets egne proporsjoner) tegnes en pil fra midten mot
pekeren, og kameraet beveger seg den veien. Jo nærmere kanten, jo fortere. Farten følger
zoomen, omtrent en utsnittsbredde på 1,5 sekunder, men aldri over maksfarten (500 km/t).
På berøringsskjerm drar man i stedet.

## Bruk

- Glideren **Indeks ↔ verden** morfer mellom matrisen og det deformerte kartet.
- **Visning** bytter mellom terreng, høyde, fuktighet, ulendthet, helning, rutestørrelse,
  jordbruk, byggegrunn og ressurser.
- Lagvisningene velges i menyen øverst til høyre, blant annet *Rutenett*, som viser rutene
  over et dempet kart. Øvrige visningsvalg ligger under *Innstillinger*.
- **Oversikt** tegner terrenget rundt det du ser (3–300 km). Klikk der for å hoppe, eller flytt
  med V/N/S/Ø.
- **Vis seksjonsgrenser** viser sømmene mellom seksjonene.
- Klikk deler en rute i fire. Høyreklikk slår sammen igjen. Dra for å panorere, bruk
  hjulet for å zoome.
