# Erzeugt die Animationen des Maskottchens als Actions am Rig, ausgehend von der Grundpose des Modells.
# Wird von export.py aufgerufen: Nur Clips, die es in der .blend noch nicht gibt, werden erzeugt. Eine Action gleichen
# Namens, von Hand in Blender angelegt, gewinnt also immer.
#
# Eine Pose ist eine Abweichung von der Grundpose: je Bone eine Drehung um die Achsen des Rigs (Grad; x = nicken,
# positiv senkt eine nach vorn zeigende Spitze, y = rollen, z = drehen), eine Verschiebung in Rig-Achsen (Meter), ein
# Anteil zur Ruhepose hin und eine Skalierung. Die Kraehe schaut nach -Y, Z ist oben. Bei 32 px ist ein Pixel etwa
# 0,18 m: Was kleiner ist, sieht man nicht.
#
# Damit es nicht steif wirkt: Ausholen vor jeder Bewegung, der Schwanz arbeitet gegen den Koerper, Atmen kommt aus
# Brust und Koerper, und der Kopf ruckt wie bei Voegeln in eine neue Lage und haelt dort, statt langsam zu drehen.

import math
import os

import bpy
from mathutils import Euler, Quaternion, Vector

BASE_ACTION = "EsqueletoAction"


class Rig:
    def __init__(self, obj):
        self.obj = obj
        ad = obj.animation_data or obj.animation_data_create()
        base = bpy.data.actions.get(BASE_ACTION)
        keep = ad.action
        if base is not None:
            ad.action = base
            bpy.context.scene.frame_set(int(base.frame_range[0]))
        bpy.context.view_layer.update()
        self.base = {pb.name: (pb.location.copy(), pb.rotation_quaternion.copy(), pb.scale.copy()) for pb in obj.pose.bones}
        # Lage jedes Bones in Rig-Achsen in der Grundpose: Drehungen und Verschiebungen werden darin ausgedrueckt.
        self.frame = {pb.name: pb.matrix.to_3x3().normalized() for pb in obj.pose.bones}
        ad.action = keep
        for pb in obj.pose.bones:
            pb.rotation_mode = "QUATERNION"

    def local(self, name, rot=(0, 0, 0), loc=(0, 0, 0), rest=0.0, scale=1.0):
        """Pose-Werte eines Bones: Grundpose, um `rest` (0..1) zur Ruhepose hin, dazu Drehung und Verschiebung in Rig-Achsen
        und eine gleichmaessige Skalierung (Cartoon-Streckung, wirkt auf alle Kinder)."""
        base_loc, base_rot, base_scale = self.base[name]
        rest = min(max(rest, 0.0), 1.0)
        q = base_rot.slerp(Quaternion(), rest) if rest else base_rot.copy()
        l = base_loc.lerp(Vector(), rest) if rest else base_loc.copy()
        m = self.frame[name]
        if any(rot):
            r = Euler([math.radians(a) for a in rot], "XYZ").to_matrix()
            q = q @ (m.inverted() @ r @ m).to_quaternion()
        if any(loc):
            l = l + base_rot.to_matrix() @ m.inverted() @ Vector(loc)
        s = Vector(scale) if isinstance(scale, (tuple, list)) else Vector((scale,) * 3)
        return l, q, Vector(a * b for a, b in zip(base_scale, s))


def make_action(rig, name, keys, length):
    """keys: [(frame, {bone: dict(rot=..., loc=..., rest=..., scale=...)})], Frames ab 0. Jeder Bone wird in jedem Key
    gesetzt, nicht genannte stehen in der Grundpose: So haengt nichts von einer anderen Action ab."""
    obj = rig.obj
    action = bpy.data.actions.new(name)
    action.use_fake_user = True
    obj.animation_data.action = action
    for frame, pose in keys:
        pose = merge(ALWAYS, pose)
        for pb in obj.pose.bones:
            l, q, s = rig.local(pb.name, **pose.get(pb.name, {}))
            pb.location, pb.rotation_quaternion, pb.scale = l, q, s
            for path in ("location", "rotation_quaternion", "scale"):
                pb.keyframe_insert(path, frame=frame + 1, group=pb.name)
    # Der Clip endet bei `length`: Pixor tastet bis vor das Ende ab.
    action.frame_range = (1, length + 1)
    action.use_frame_range = True
    obj.animation_data.action = None
    return action


def add_eye_bones(eye_materials=("Material.005", "Material.006")):
    """Das Modell hat keine Lider: Jedes Auge haengt an einem eigenen Bone (eye.L, eye.R, Kinder von head, zeigen nach
    oben), den eyes_shut() zum Blinzeln in den Kopf zieht."""
    rig = next(o for o in bpy.data.objects if o.type == "ARMATURE")
    if "eye.L" in rig.data.bones:
        return
    sides = {"L": [], "R": []}
    for o in bpy.data.objects:
        if o.type != "MESH" or not any(m.type == "ARMATURE" for m in o.modifiers):
            continue
        slots = {i for i, m in enumerate(o.data.materials) if m and m.name in eye_materials}
        verts = {i for p in o.data.polygons if p.material_index in slots for i in p.vertices}
        for i in verts:
            world = o.matrix_world @ o.data.vertices[i].co
            sides["L" if world.x > 0 else "R"].append((o, i, world))
    if not sides["L"] or not sides["R"]:
        return
    bpy.context.view_layer.objects.active = rig
    bpy.ops.object.mode_set(mode="EDIT")
    to_rig = rig.matrix_world.inverted()
    for side, items in sides.items():
        centre = sum((w for _, _, w in items), Vector()) / len(items)
        bone = rig.data.edit_bones.new(f"eye.{side}")
        bone.head = to_rig @ centre
        bone.tail = bone.head + Vector((0, 0, 0.2))
        bone.parent = rig.data.edit_bones["head"]
        bone.use_deform = True
    bpy.ops.object.mode_set(mode="OBJECT")
    for side, items in sides.items():
        for o, i, _ in items:
            for g in list(o.data.vertices[i].groups):
                o.vertex_groups[g.group].remove([i])
            group = o.vertex_groups.get(f"eye.{side}") or o.vertex_groups.new(name=f"eye.{side}")
            group.add([i], 1.0, "REPLACE")
    print(f"animate.py: Augen-Bones eye.L ({len(sides['L'])}), eye.R ({len(sides['R'])})")



def ensure_clips(clips=None):
    clips = CLIPS if clips is None else clips
    add_eye_bones()
    rig = Rig(next(o for o in bpy.data.objects if o.type == "ARMATURE"))
    made = []
    for name, (length, keys, *looping) in clips.items():
        if name in bpy.data.actions:
            continue
        # Ein Loop endet vor seinem letzten Key (der ist sein Anfang); ein einmaliger Clip zeigt ihn, sonst endet er mitten
        # in der Bewegung statt in seiner Schlusspose.
        make_action(rig, name, keys, length if looping else length + 1)
        made.append(name)
    return made


# ---- Bausteine -------------------------------------------------------------------------------------------------------

def merge(*poses):
    """Posen ueberlagern: Drehungen und Verschiebungen addieren sich, Skalierungen multiplizieren sich."""
    out = {}
    for pose in poses:
        for bone, part in pose.items():
            have = out.setdefault(bone, dict(rot=(0, 0, 0), loc=(0, 0, 0), rest=0.0, scale=1.0))
            have["rot"] = tuple(a + b for a, b in zip(have["rot"], part.get("rot", (0, 0, 0))))
            have["loc"] = tuple(a + b for a, b in zip(have["loc"], part.get("loc", (0, 0, 0))))
            have["rest"] = max(have["rest"], part.get("rest", 0.0))
            a, b = have["scale"], part.get("scale", 1.0)
            if isinstance(a, (tuple, list)) or isinstance(b, (tuple, list)):
                a3 = a if isinstance(a, (tuple, list)) else (a,) * 3
                b3 = b if isinstance(b, (tuple, list)) else (b,) * 3
                have["scale"] = tuple(x * y for x, y in zip(a3, b3))
            else:
                have["scale"] = a * b
    return out


def eyes_shut(sides=("L", "R")):
    """Augen zu. Pixor zeichnet jedes sichtbare Auge in seiner Mindestgroesse, ein gestauchtes also wie ein offenes:
    Die Augen-Bones (export.py) ziehen das Auge darum klein in den Kopf zurueck, dann zeichnet Pixor keins.
    MASCOT_EYES=open (Sonde in build.mjs) laesst das nahe Auge offen: So findet build.mjs, wo der Strich fuers
    geschlossene Auge hingehoert."""
    if os.environ.get("MASCOT_EYES") == "open":
        sides = tuple(s for s in sides if s != "L")
    return {f"eye.{s}": dict(scale=0.3, loc=(-sign * 0.25, 0.3, 0)) for s, sign in (("L", 1), ("R", -1)) if s in sides}


def rot(bone, x=0, y=0, z=0):
    return {bone: dict(rot=(x, y, z))}


def lift(bone, z, y=0):
    return {bone: dict(loc=(0, y, z))}


WING_BONES = ("wing.L.c1", "wing.L.c2", "wing.L.c3", "wing.R.c1", "wing.R.c2", "wing.R.c3")


def wing(side, flap=0.0, size=1.0, sweep=0.0, spread=1.0, twist=0.0):
    """Ein Fluegel (L ist der zur Kamera): spread 0 angelegt .. 1 ausgebreitet, flap Grad nach oben, size streckt ihn
    (die Fluegel des Modells sind kurz), sweep schwenkt ihn nach hinten, damit er von der Seite nicht hinter dem Kopf liegt,
    twist dreht ihn um die Querachse."""
    sign = -1 if side == "L" else 1
    pose = {f"wing.{side}.c{i}": dict(rest=spread) for i in (2, 3)}
    pose[f"wing.{side}.c1"] = dict(rest=spread, rot=(twist, sign * flap, -sign * sweep), scale=size)
    return pose


def wings(flap=0.0, size=1.0, sweep=0.0, spread=1.0, twist=0.0):
    return merge(wing("L", flap, size, sweep, spread, twist), wing("R", flap, size, sweep, spread, twist))


def ruffle(amount):
    """Fluegel leicht abgespreizt, z. B. beim Aufplustern."""
    return {b: dict(rest=amount) for b in WING_BONES}


BEAK_SHUT = merge(rot("Beak C1", 30), rot("Beak c2", -30))
# Das Modell steht mit weit offenem Schnabel und hoch erhobenem Kopf: Geschlossen und leicht gesenkt liest es sich als Kraehe.
NEUTRAL = merge(BEAK_SHUT, rot("head", 6))


def tail(x):
    return rot("Tail.c1", x)


def loop(length, *keys):
    """Ein Loop: der letzte Key ist der erste."""
    return (length, list(keys) + [(length, keys[0][1])], True)


def still(pose, length=2):
    return (length, [(0, pose), (length, pose)])




def scaled(pose, k):
    """Eine Pose staerker (k > 1, Ueberschwingen), schwaecher oder entgegengesetzt (k < 0, Ausholen)."""
    out = {}
    for bone, part in pose.items():
        s = part.get("scale", 1.0)
        s = tuple(1 + (x - 1) * k for x in s) if isinstance(s, (tuple, list)) else 1 + (s - 1) * k
        out[bone] = dict(rot=tuple(a * k for a in part.get("rot", (0, 0, 0))), loc=tuple(a * k for a in part.get("loc", (0, 0, 0))),
                         rest=max(0.0, part.get("rest", 0.0) * k), scale=s)
    return out


def jump(z):
    """Der ganze Vogel hebt ab, Fuesse eingeschlossen (lift auf Hueso streckt nur die Beine)."""
    return lift("Control", z)


# ---- Die Clips -------------------------------------------------------------------------------------------------------
# Frame-Nummern ab 0 bei 24 fps, welche ins Sheet kommen, steht in mascot.json. Jede Bewegung holt aus, schiesst etwas
# ueber das Ziel hinaus und federt zurueck; die Keys sind Bezier, also mit Easing.

# Das abgewandte Auge schaut bei gehobenem Kopf ueber die Silhouette und wird zu einem zweiten Augenpunkt: immer weg.
ALWAYS = eyes_shut(("R",))


def P(*parts):
    return merge(NEUTRAL, *parts)



PECK_READY = merge(rot("Hueso", -6), rot("head", -10), tail(-4))
PECK_HALF = merge(rot("Hueso", 16), rot("head", 22), tail(10))
PECK_DOWN = merge(rot("Hueso", 30), rot("head", 42), tail(18))

CAW_BODY = merge(rot("head", -16), rot("chest", -8), tail(-12), ruffle(0.18))
# Oben bleibt der Schnabel fast stehen, der Unterschnabel klappt auf: Bei 16 px liest sich nur das als offener Schnabel.
CAW_BEAK = merge(rot("Beak C1", -12), rot("Beak c2", 58))

# Aufplustern und schuetteln: Nur das Gefieder plustert sich, nicht der Bauch. Die Fluegel heben sich vom Koerper ab, die
# Kopffedern stehen (Kopf etwas groesser, sinkt dabei ein), der Schwanz hebt sich. Der Koerper waechst nicht: Die Beine haengen an ihm
# und wuerden mitwachsen. Geschuettelt
# wird in der Bildebene: Der Koerper wippt vor und zurueck, der Schwanz gegen ihn, die Augen sind dabei zu.
PUFF = merge({"head": dict(scale=1.12), "Beak C1": dict(scale=1 / 1.12), "Beak c2": dict(scale=1 / 1.12)}, lift("Neck", -0.08),
             rot("head", 8), tail(16), ruffle(0.85))


def shake(k):
    return merge(rot("Hueso.001", k * 12), rot("head", -k * 6), tail(-k * 16), ruffle(0.2 * abs(k)))

DOZE = merge(eyes_shut(), rot("head", 26), rot("chest", 10), lift("Hueso", -0.14), tail(-8))
DOZE_BREATH = merge(lift("Hueso", -0.07), rot("head", 5), rot("chest", 3))

CROUCH = merge(lift("Hueso", -0.16), rot("chest", 8), rot("head", 8), tail(-8))
LAND = merge(lift("Hueso", -0.12), tail(-6))
JOY = merge(rot("head", -16), rot("chest", -8), jump(0.5), tail(14), wings(flap=110, size=1.2, sweep=-10), scaled(CAW_BEAK, 0.7))

# Den Kopf nur so weit senken, dass der Schnabel schraeg bleibt: Steht er senkrecht, rastert Pixor ihn jeden Frame anders.
SAD = merge(rot("head", 14), rot("chest", 17), lift("Hueso", -0.1), tail(-16))
SIGH_IN = merge(rot("chest", -13), rot("head", -5), lift("Hueso", 0.05), tail(-7))

# Gewinkt wird mit dem nahen Fluegel, in der Bildebene: Von der Seite gesehen hebt ihn nur die Drehung um X (twist),
# flap schwenkt ihn zur Kamera und ist kaum zu sehen; flap -50 haelt ihn vom Koerper weg. A: Spitze hoch neben dem Kopf,
# B: schraeg nach hinten unten.
# Der Koerper winkt mit: Fluegel oben, Koerper leicht zurueckgelehnt, Schwanz runter; Fluegel unten, Koerper etwas vor,
# Schwanz hoch. Das Heben um ein Pixel bei gehobenem Fluegel macht build.mjs (bob in mascot.json).
WAVE_A = merge(rot("head", -6), rot("chest", -6), tail(-8), wing("L", flap=-40, size=1.8, twist=125, sweep=55, spread=0.6))
WAVE_B = merge(rot("head", -2), rot("chest", 2), tail(6), wing("L", flap=-40, size=1.8, twist=40, sweep=10, spread=0.6))

# Flug: Koerper waagrecht, Fuesse angezogen, Fluegel gestreckt und im Bild im Uhrzeigersinn gedreht; der Koerper hebt
# sich, wenn die Fluegel nach unten schlagen. 8 Frames je Schlag, wie die Werkbank sie abspielt.
FLY_BODY = merge(BEAK_SHUT, rot("Control", 25), rot("head", -10), lift("foot.l", 0.35, 0.3), lift("foot.R", 0.35, 0.3), tail(-4))
FLAPS = [(70, -0.1), (45, -0.05), (-5, 0.05), (-50, 0.15), (-65, 0.2), (-45, 0.15), (5, 0.0), (50, -0.08)]


def fly(flap, rise):
    return merge(FLY_BODY, wings(flap=flap, size=1.2, sweep=35, twist=-25), jump(rise))


CLIPS = {
    # Zwei gehaltene Lagen mit kurzem Uebergang: Ein weiches Auf und Ab laege meist zwischen zwei Pixeln. Ausgeatmet (die
    # Ruhepose der anderen Clips) etwas laenger als eingeatmet, wie Madelines Idle in Celeste; eine Sekunde je Atemzug.
    # Das Heben um ein Pixel macht build.mjs aus der Ruhepose (bob in mascot.json), hier steht nur die Pose.
    "idle": loop(24, (0, NEUTRAL), (12, NEUTRAL)),
    # Ausholen, schnell runter mit Ueberschwingen, kurz halten, zurueck.
    "peck": (10, [(0, P(PECK_READY)), (2, P(PECK_HALF)), (3, P(scaled(PECK_DOWN, 1.12))), (5, P(PECK_DOWN)), (7, P(PECK_HALF)), (10, P(PECK_READY))]),
    "blink": (8, [(0, NEUTRAL), (1, P(eyes_shut())), (3, P(eyes_shut())), (4, NEUTRAL), (8, NEUTRAL)]),
    "caw": (14, [(0, NEUTRAL), (3, P(scaled(CAW_BODY, -0.35))), (5, P(scaled(CAW_BODY, 1.1), scaled(CAW_BEAK, 0.77))),
                 (7, P(CAW_BODY, scaled(CAW_BEAK, 0.7))), (10, P(CAW_BODY, scaled(CAW_BEAK, 0.6))), (12, P(scaled(CAW_BODY, 0.3))), (14, NEUTRAL)]),
    "puff": (24, [(0, NEUTRAL), (3, P(scaled(PUFF, -0.4))), (6, P(scaled(PUFF, 1.15))), (8, P(PUFF)),
                  (10, P(PUFF, shake(1), eyes_shut())), (12, P(PUFF, shake(-1), eyes_shut())), (14, P(PUFF, shake(0.6), eyes_shut())),
                  (16, P(PUFF, eyes_shut())), (20, P(scaled(PUFF, -0.15))), (24, NEUTRAL)]),
    "doze": loop(24, (0, P(DOZE)), (12, P(DOZE, DOZE_BREATH))),
    "wave": loop(10, (0, P(WAVE_A)), (5, P(WAVE_B))),
    # Oben kurz in der Luft stehen (hang time), dann fallen.
    # Landen nur mit dem Koerper (LAND), der Kopf bleibt gerade: Neigte er sich wie beim Absprung, wackelte er am Ende.
    # Die letzten Keys liegen auf geraden Frames (auf Zweien gezeigt), so gibt es nach der Landung keinen Zwischenframe.
    "joy": (20, [(0, NEUTRAL), (3, P(CROUCH)), (6, P(scaled(JOY, 1.1))), (8, P(JOY)), (10, P(JOY)), (12, P(scaled(JOY, 0.85))),
                 (14, P(LAND)), (16, NEUTRAL), (20, NEUTRAL)]),
    "sad": (16, [(0, NEUTRAL), (5, P(scaled(SAD, 0.55))), (9, P(SAD)), (16, P(SAD))]),
    "sigh": (20, [(0, NEUTRAL), (6, P(scaled(SIGH_IN, 1.1))), (9, P(SIGH_IN)), (14, P(scaled(SAD, 0.75))), (17, P(scaled(SAD, 0.7))), (20, P(scaled(SAD, 0.7)))]),
    # Nicken: Kopf ruckartig runter, halten, zurueck. Nur so weit, dass der Schnabel schraeg bleibt (wie bei SAD), sonst
    # rastert Pixor ihn senkrecht jeden Frame anders und er biegt sich wie Gummi. Die Brust nickt etwas mit.
    "nod": loop(10, (0, NEUTRAL), (2, P(rot("head", 13), rot("chest", 4))), (5, P(rot("head", 12), rot("chest", 4))), (7, P(rot("head", -2)))),
    "fly": loop(8, *[(i, fly(f, r)) for i, (f, r) in enumerate(FLAPS)]),
}