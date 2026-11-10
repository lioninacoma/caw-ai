-- GIFs aus einem Sheet nach einer Frame-Liste (build.mjs schreibt sie). Laeuft in Aseprite ohne Oberflaeche:
--   Aseprite -b --script-param sheet=out/clips.png --script-param list=out/gif/frames.txt --script-param dir=out/gif
--                --script-param cell=32 --script-param scale=4 --script gifs.lua
-- Jede Zeile der Liste: <name> <spalte> <zeile> <millisekunden>; alle Zeilen eines Namens werden ein GIF.

local p = app.params
local sheet = Image{ fromFile = p.sheet }
local cell = tonumber(p.cell or "32")
local scale = tonumber(p.scale or "4")
local background = app.pixelColor.rgba(231, 234, 242, 255)

local order, animations = {}, {}
for line in io.lines(p.list) do
  local name, c, r, ms = line:match("^(%S+) (%d+) (%d+) (%d+)$")
  if name then
    if not animations[name] then animations[name] = {}; order[#order + 1] = name end
    table.insert(animations[name], { tonumber(c), tonumber(r), tonumber(ms) })
  end
end

for _, name in ipairs(order) do
  local frames = animations[name]
  local sprite = Sprite(cell, cell, ColorMode.RGB)
  local layer = sprite.layers[1]
  for i, f in ipairs(frames) do
    if i > 1 then sprite:newEmptyFrame() end
    local image = Image(cell, cell, ColorMode.RGB)
    image:clear(background)
    image:drawImage(sheet, Point(-f[1] * cell, -f[2] * cell), 255, BlendMode.NORMAL)
    sprite:newCel(layer, i, image, Point(0, 0))
    sprite.frames[i].duration = f[3] / 1000
  end
  sprite:resize(cell * scale, cell * scale)
  sprite:saveAs(app.fs.joinPath(p.dir, name .. ".gif"))
  sprite:close()
end
print("gifs.lua: " .. #order .. " GIFs")
