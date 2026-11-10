// Der urspruengliche Rabe (assets/raven-sheet.png, von Hand gezeichnet, doppelt so gross angezeigt).
// npm run mascot -- --install ersetzt Sheet, Favicon und diese Tabelle durch die Kraehe aus assets/mascot.
// Je Clip die Frames als [Spalte, Zeile, Millisekunden]; cell, width und height in CSS-Pixeln.
export const RAVEN_CLIPS = {"cell":32,"width":256,"height":192,"feet":0,"shift":{},"clips":{
"idle":[[0,0,520],[1,0,520]],
"fly":[[0,1,55],[1,1,55],[2,1,55],[3,1,55],[4,1,55],[5,1,55],[6,1,55],[7,1,55]],
"peck":[[0,2,115],[1,2,115],[2,2,115],[1,2,115]],
"blink":[[0,3,160]],
"caw":[[0,0,140],[1,3,380],[0,0,120],[1,3,360]],
"puff":[[2,3,90],[0,0,90],[2,3,90],[0,0,90],[2,3,90],[0,0,90],[2,3,90],[0,0,90],[2,3,90],[0,0,90]],
"doze":[[3,3,3200]],
"wave":[[0,4,160],[1,4,160]],
"joy":[[2,4,520]],
"sad":[[5,4,300]],
"sigh":[[6,4,450],[5,4,450]],
"nod":[[1,5,175],[2,5,175]]}};
