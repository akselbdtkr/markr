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
- **Dalprofiler:** tverrsnittet av et nedsenk er en blanding av fire profiler. Andelene
  kommer fra to diagrammer der du drar tre terskler, `[` → `(` → `{` → `<`. Det ene går etter
  landskapstype, fra slette til fjellsk, og det andre etter høyde, fra lavland til høyland.
  De to blandes, og «Høyden teller» avgjør hvor mye høyden veier. Den myke terskelen i
  nedsenket tar formen de andre lagene gir den:
  - `[` flat bunn og bratte sider, i løs grunn: løse sletter og løse åser i lavland.
  - `(` myk og rund, en U-dal, i åser og høyland. Formen er (1 − t²)², flat både i bunnen og
    ved kanten, så dalen synker mykt ned fra landet.
  - `{` to myke terskler, en flat hylle og en bratt kløft i midten, en kanyon, på platå.
  - `<` rette sider som møtes i en spiss, en V-dal, i fjellsk.

  Når nedsenkslaget vises alene (øyet), farges nedsenkene etter dalprofilen, med samme farger
  som kurvene i diagrammene, og sterkere der båndet er dypere.
- **Linjebredde og myke kanter:** bredden på båndet og hvor langt S-kurven går ut fra
  linja kan justeres hver for seg.
- **Retning:** deler av båndet som går på tvers av helningen, blir grunne. Dype,
  sammenhengende nedsenkninger går derfor med helningen.

### Elvene (`src/riverline.js`)

Elvene regnes punkt for punkt, men alt leses i bunnen av snittet. Bunnen er linja der
nedsenk-støyen er 0. Fra et punkt gir ett Newton-steg på tvers bunnpunktet, og avstanden dit.
Alle punkter i samme snitt finner samme bunnpunkt, så begge breddene får samme bredde og
vannflate.

- **Hvor:** bare der nedsenket er dypt i bunnpunktet («Dypt nok nedsenk»), på land og et
  stykke inn i vanndelingsfeltet. Elva følger da samme regel som nedsenket. Før brukte elva
  sin egen retningsterskel og kunne gå på tvers mellom nedsenkene. Der strekkingen blander
  to nivåer, kan nullinjen gå på skrå fra ett nedsenk til det neste, og der er nedsenket
  grunt. Elva avtar med en S-kurve når båndet svekkes. Den avtar raskt i fast fjellsk og i løse sletter og
  platåer, og mykere i åser og i løst lavland og høyland.
- **Bredde:** volum delt på dybde. Volumet er produktet av to kurver du drar i, uten
  terskel: størrelse etter høyde og størrelse etter fasthet. Punktene ligger tettest der
  elvebunnene er vanlige (lavt og løst), og søylene bak viser hvor de ligger. Dybden følger
  fastheten: fast grunn gir dypt løp, løs grunn grunt. En grunnere elv blir derfor bredere,
  opptil «Bredde» (1 km) ved vannet i løs grunn. Høydekurven går fra havet til vanndelingen,
  og «Minste bredde» holder elva synlig helt opp.
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

### Elvene per seksjon: elvetrær (`src/riversections.js`)

Et eget steg som kjører når utsnittet er mindre enn «Per seksjon» (5 km). Første gang en
seksjon tegnes, lagres elvene der, og funksjoner går gjennom dem.

1. **Lagre:** fra hver andre rute finnes bunnen av snittet, flyttet nøyaktig på linja.
   Bunnpunktene lagres i et rutenett på to ruter. Av to punkter nærmere enn 1,5 rute blir
   det med lavest indeks stående, uansett hvilken seksjon som fant det. Resultatet avhenger
   derfor ikke av rekkefølgen seksjonene lastes i. Elver under havet lagres ikke.
2. **Kjeder:** hvert bunnpunkt kobles til nærmeste foran og bak langs linja. En kjede gås
   fra ende til ende. En kjede som kommer tilbake til seg selv, er en ring, og den fjernes.
3. **Trær:** hver kjede har sitt eget faste steg videre fra den laveste enden: til
   nærmeste ende av en annen kjede som vender tilbake (kobling), ellers midt inn i en annen
   elv foran (sideelv), ellers nedover landet (vei nedover). Ved å følge stegene fra kjede
   til kjede ser vi om en kjede når havet, og alle som gjør det, utgjør trærne. Alt avhenger
   bare av kjeden selv. Trærne oppstår derfor mens spilleren utforsker, og blir like
   uansett rekkefølge. En seksjon tegner bare kjedene innen fast avstand, med deres egne
   steg.
4. **Ingen vei til havet ennå:** kjeden tegnes som elv, men er ingen vannvei. En kort kjede
   blir en liten innsjø. En bit av en ring fjernes. Det gjelder en trang, lukket linje som
   ofte er brutt i biter: radius fra tre punkter under koblingsavstanden, minst en radian av
   sirkelen, og linja finnes også på motsatt side av sentrum. Dette gjelder særlig langt inne i landet der veien nedover møter
   en grop. Neste steg er å fylle gropa til en innsjø og finne utløpet.
   Stegene videre (koblinger og sideelver) tegnes for alle kjeder, også dem som ikke når
   havet ennå, så elvene inne i landet ikke brytes opp. En vei nedover som ender i en grop,
   tegnes ikke.
5. **Elver av flere kjeder:** før noe bedømmes, kobles kjeder ende mot ende der to ender er
   hverandres beste partner (nærmeste ende innen to ganger «Koble ender», foran og vendt
   tilbake). Koblingen må gå begge veier, så rekkefølgen spiller ingen rolle. Den sammenkoblede
   elva bedømmes som én: rettethet, bredde, rekkevidde og om den blir innsjø gjelder hele
   elva. Et kort stykke mellom to lange blir derfor en del av en lang, rett elv. Et kort
   stykke (under to ganger «Koble ender») har samme vannstand hele veien: den laveste.
   Nære ender (under «Koble ender») kan møtes i nesten alle vinkler, så linjer som overlapper
   side om side blir en S. Fjernere ender må ligge foran og vende tilbake. Den beste partneren
   velges etter avstand og hvor mye linjene må svinge. Koblinger er myke kurver som går ut og
   inn langs elvene, ikke rette streker. En kobling har elvas fulle bredde når elva er alene, og
   blir en smal bekk der andre elver og innsjøer ligger tett. Sideelver er siste utvei: kort
   rekkevidde, godt foran, og bare inn i en elv som er omtrent like bred eller bredere.
   Hver ende har høyst én kobling, og hvilken er fast. Ender kobles bare til hverandre
   gjennom slike gjensidige par. Munningen til en elv kan bare gå inn midt på en annen elv,
   aldri på en ende, og bare til en elv med lavere rang (lavere vannstand ved munningen, likhet
   avgjøres av indeks). Stegene kan derfor ikke gå i sirkel. Kjeder som er parvis koblet hele
   veien rundt, er en ring og fjernes. Kjeder med bare ett punkt kobles ikke.
   **Retning:** hver elv får en rettethet: avstanden mellom endene delt på lengden langs
   kjeden (1 er rett, nær 0 er en sløyfe). Rette kjeder beholder bredden og leter etter
   koblinger opptil to ganger «Koble ender». Bøyde kjeder blir smalere, leter kortere og blir
   innsjøer hvis de ikke når havet og har rettethet under «Bøyd kjede». Koblinger går jevnt
   fra bredden i den ene enden til den andre, og slynger seg høyst en halv bredde.
6. **Bekker under en rute:** en elv smalere enn ruta gjør ikke ruta til vann. Ruta får i
   stedet en blåtone etter hvor stor del av den elva dekker, så smale elver ikke brytes opp.
7. **Bekker fra utspring:** bare fra en elveende som ikke finner noen annen kobling, verken en
   partner eller en annen elveende i nærheten. Utspringet finnes som i ruteformlene, som toppen
   av en dal. Rundt elveenden testes punkter: et dalpunkt ligger lavere enn landet rundt
   («Bekk fra utspring»), og det er toppen av dalen når landet like ovenfor ikke lenger er dal.
   Nærmeste slike punkt som ligger høyere enn enden og foran den, er utspringet. Veien ned
   finnes ved å forskyve midtpunktet: midtpunktet på linja flyttes på tvers til det laveste
   landet innen en gitt avstand, så gjøres det samme med de to halvdelene, og så videre.
   Vann regnes som stengt, og linja glattes. Bekken graver en myk renne i landet.
8. **Sund:** en kjede der begge ender åpner mot havet, blir et sund med vannflate på 0 m.

Steget per seksjon legger til vann (koblinger, sideelver, innsjøer) til elva som regnes
punkt for punkt, men tar ikke bort noe. En elv som allerede er sammenhengende, brytes derfor
aldri opp. Bare ringer og ringbiter fjernes.

«Elvenes bunnpunkter og koblinger» viser dette med tegnforklaring.

### Det lokale laget (`src/locallayer.js`)

Terrengets egne detaljer, formet av alle lagene under. Formen følger landskapstypen gjennom
fem kurver langs slette → åser → platå → fjellsk, som dras opp og ned: høyde, størrelse,
skarphet (fra rullende fbm til ridged rygger), strekking langs helningen og ruhet (hvor mye
de små oktavene teller, altså hvor brå endringene er). Fjellsk ligger over isbreene og elvene
og har mest lokal deformasjon igjen: høyt, skarpt, røft og lite strukket. Åser er rullende og
strukket mest, platå mykt og lavt, og sletter nesten flate.

«Detaljer» og «Fjellegger» kan skrus av og på, og har hver sin skala og vekt.

Fjellegger er et eget lag: ridged noise med to oktaver, kvadrert for skarpe egger og bratte,
uthulte sider, strukket langs landet under med fast strekking, så eggene følger retningen der.
Standard er 900 m store egger og 1500 m høyde. Skar lages av vanlig noise (fbm, ikke strukket): der den
er høy, hogger den inn i eggene, dypest høyt oppe og minst lenger ned («Skar»: størrelse og
dybde, av/på). Skarene virker både i fjell og i åser. «Detaljer», «Fjellegger» og «Skar» har
hvert sitt øye, som viser bare den delen: endringen i høyde, i grått med skygge. Fastheten virker også: fast grunn gir
fjellegger uansett landskapstype («Fjell i fast grunn»), og gjør detaljene høyere og skarpere,
mens løs grunn gjør dem lavere og mykere («Fasthet → detaljer»). Laget blir sterkere med fjellsk og over
vanndelingen, og løfter mest, så fjellene vokser over vanndelingen. De høyeste toppene blir
hvite («Snø», fra og til i meter over havet).

Støyen i laget leses bare ved faste størrelser (toerpotenser) og faste strekkinger, og
blandes mellom dem. Med en størrelse som varierer fra sted til sted, glir fasen i x / L langt
fra origo, og det tegnes ringer langs konturene av landskapstypen.

Skyggen regnes etter flatens retning mot lyset (Lambert), med virkelig helning på skjermen.
Bratte fjell viser derfor detaljene sine i stedet for å bli helt mørke.

Laget samspiller med dalprofilene. I bunnen av et nedsenk dempes det («Flat dalbunn»), mest
for `[` og `{`. På sidene forsterkes det («Brattere sider»). Nær elva jevnes det ut mot vannet
(«Jevnes mot vannet»). «Bredd» flytter elvekanten inn og ut med et noise-lag langs elva, så
elva både spiser av landet og gir etter for det, og får en lokal slyng. Laget vises når
utsnittet er under 25 km.

**Målestokk:** simuleringen har sine egne enheter. På skjermen er én enhet 1/50 m
bortover og 1/10 m i høyden (justerbart: «Målestokk 1:» og «Høyde 1:»). Laget er laget i stor
skala, men spillet skal spilles i utsnitt på 2 km til 100 m, så kontinentene blir ca. 60 km,
dalene noen hundre meter og fjellene noen hundre meter høye. Størrelser i panelet vises i
skjermens km og m. En rute på 16 m er 800 enheter.

**Bratthet:** visningen «Bratthet» farger landet etter virkelig helning på skjermen: grønt flatt,
gult 15°, oransje 25°, rødt 35° og mørkerødt fra 45°. Det meste av brattheten kom fra de lokale
lagene, fordi høyden ikke fulgte størrelsen. De har derfor en grense for hvor bratte de kan bli:
høyden begrenses ut fra størrelse og oktaver, så de bratteste flatene holder seg nær «Brattest,
detaljer» (25°) og «Brattest, fjell og skar» (75°). I fjellsk dempes nedsenkene
(«Svakere i fjellsk»), så fjellene leder og nedsenkene ikke tegner tydelige linjer gjennom dem. Mot elva blir sonen bredere med fallet ned
til vannet, så breddene ikke blir brattere enn «Brattest mot elva» (15°). Nedsenkene har også en
grense («Brattest side»): dybden begrenses av halve bredden.

**Kant rundt utsnittet:** bildet tegnes 15 % større enn utsnittet på hver side, og kanten
tones ut. Når du flytter kartet eller zoomer ut, fyller det ferdige bildet inn, og det glir over
i den grove versjonen av grunnlagene utenfor. Målestokken tegnes fast på skjermen, så den
følger ikke med bildet.

**Zoom og flytting:** grunnlagene og mellomlaget tegnes først, i grove ruter, så land og hav
er på plass med en gang, også utenfor det gamle bildet når du zoomer ut. Det nye bildet tegnes utenfor skjermen. Imens står det forrige bildet,
flyttet og skalert til det nye utsnittet. Når det nye er ferdig, kryssfades det inn over det
gamle.

**Ingen brå sprang:** sonen rundt elva er aldri bredere enn rekkevidden elva regnes ut i, og
den, og dempingen av det lokale laget nær elva, tones inn med elva. Før kunne landet falle
mange hundre meter på én rute der sonen stoppet. Mot havet tones det lokale laget ut, så
kysten ikke får stup. Langs nedsenkene gir fjellegger og skar etter («Lokale lag», 80 % i
bunnen av et nedsenk), så dalen går jevnt inn i fjellet. Nær elva tones det lokale laget ut
over så lang avstand som trengs for at fallet holder seg under «Brattest mot elva».

**Forenkling langt ute:** lagene skrus av ett og ett etter hvor stort utsnittet er på
skjermen: elver over 60 km, nedsenkslaget over 150 km og områdelagene over 300 km. Da står
bare grunnlagene og mellomlaget igjen. Grensene kan endres i hver seksjon. De glatte lagene
regnes aldri finere enn to tegnede punkter.

**Raskere tegning:** kartet tegnes aldri finere enn én rute (16 m på skjermen). I store
utsnitt hoppes elver over der selv den bredeste elva på stedet ville vært under to tegnede
punkter. Det anslås billig fra høyde og fasthet, før selve elvesjekken. Seksjonene bruker et
rutenett på to ruter for nedsenkslinjene.

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

## Byen

`by.html` er starten på bylogikken. Det tar grunnkartet med alle lagene (kjeden ligger i
`src/grunnchain.js` og deles med `grunn.html`) og legger ruteformlene (`src/formula.js`) over.
Rutene tegnes fylt og ugjennomsiktige, i fargen til landskapstypen de står på (eller etter
rutetype), med skygge fra helningen. Landskapet under vises ikke.

- Utsnitt fra 10 km til 100 m. En rute er 16 m på skjermen.
- Høydene leses alltid med alle lag og elvene per seksjon, så en rute er den samme uansett zoom.
- Høydene regnes i biter på 32 × 32 ruter av flere workers side om side (`src/byworker.js`,
  `src/bychunk.js`), og formlene i felt på 64 × 64 ruter med en kant på 3 ruter som regnes men
  ikke tegnes, så feltene passer sammen.
- Langt ute lagres hvert felt som et bilde per zoomtrinn.
- Innstillinger kopiert fra grunnvinduet kan limes inn.

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
