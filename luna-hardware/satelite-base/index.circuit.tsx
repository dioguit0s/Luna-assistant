/**
 * Luna — placa-base do satélite (piloto tscircuit)
 *
 * Fonte única da pinagem: luna-firmware/include/config.h (e docs/PINAGEM_EPICO_2.md).
 * Mudar um GPIO aqui sem mudar lá (ou vice-versa) é regressão silenciosa.
 *
 * Escopo do piloto: ESP32-S3-WROOM-1-N16R8 + USB-C (alimentação e USB nativa)
 * + LDO 3,3 V + botões RESET/BOOT/USER + LED RGB de estado. Microfone (INMP441)
 * e amplificador (MAX98357A) entram como módulos em barras de pinos, iguais aos
 * da protoboard validada — a próxima revisão pode trazê-los para a placa.
 */
import { ESP32_S3_WROOM_1_N16R8 } from "./imports/ESP32_S3_WROOM_1_N16R8"
import { AMS1117_3_3 } from "./imports/AMS1117_3_3"
import { TS_1187A_B_A_B } from "./imports/TS_1187A_B_A_B"
import { S6_3528RGBTA } from "./imports/S6_3528RGBTA"

// GPIOs — espelho de luna-firmware/include/config.h
const MIC_SD = "IO12"
const MIC_WS = "IO5"
const MIC_SCK = "IO6"
const SPK_DIN = "IO7"
const SPK_BCLK = "IO16"
const SPK_LRC = "IO17"
const LED_R = "IO10"
const LED_G = "IO13"
const LED_B = "IO14"
const USER_BTN = "IO2" // reservado no firmware para o botão físico

export default () => (
  <board
    width="50mm"
    height="45mm"
    layers={2}
    title="Luna Satelite Base"
    // Folgas mínimas da JLCPCB (2 camadas) com margem; o DRC do KiCad exige 0,2 mm até furo
    minTraceToPadEdgeClearance="0.2mm"
    minViaEdgeToPadEdgeClearance="0.2mm"
  >
    <schematicsection name="Power" displayName="Alimentação 5V→3V3" />
    <schematicsection name="MCU" displayName="MCU" />
    <schematicsection name="UI" displayName="LED de estado e botões" />
    <schematicsection name="Audio" displayName="Áudio I2S (módulos)" />

    {/* ---------------- Alimentação ---------------- */}
    <connector
      name="J1"
      standard="usb_c"
      pcbX={0}
      pcbY={-16.9}
      schWidth={1.772}
      schSectionName="Power"
      schX={-14}
      schY={4}
    />
    {/* CC1/CC2 com 5,1 kΩ para GND: identifica a placa como sink e libera 5 V */}
    <resistor name="R1" resistance="5.1k" footprint="0402" pcbX={-6.5} pcbY={-15} schSectionName="Power" schX={-11} schY={1} schRotation={270} />
    <resistor name="R2" resistance="5.1k" footprint="0402" pcbX={6.5} pcbY={-15} schSectionName="Power" schX={-10} schY={1} schRotation={270} />
    <trace from="J1.CC1" to="R1.pin1" />
    <trace from="J1.CC2" to="R2.pin1" />
    <trace from="R1.pin2" to="net.GND" />
    <trace from="R2.pin2" to="net.GND" />
    <trace from="J1.VBUS1" to="net.V5" thickness="0.4mm" />
    <trace from="J1.VBUS2" to="net.V5" thickness="0.4mm" />
    <trace from="J1.GND1" to="net.GND" />
    <trace from="J1.GND2" to="net.GND" />

    <AMS1117_3_3 name="U1" pcbX={-15} pcbY={-14} schSectionName="Power" schX={-10} schY={5} />
    <trace from="U1.VIN" to="net.V5" thickness="0.4mm" />
    <trace from="U1.GND" to="net.GND" />
    <trace from="U1.VOUT1" to="net.V3_3" thickness="0.4mm" />
    <trace from="U1.VOUT2" to="net.V3_3" thickness="0.4mm" />
    {/* AMS1117: ≥10 µF na entrada; 22 µF na saída para os picos de RF (~355 mA) do ESP32 */}
    <capacitor name="C1" capacitance="10uF" footprint="0805" pcbX={-14} pcbY={-19} schSectionName="Power" schX={-12} schY={7} schRotation={270} />
    <capacitor name="C2" capacitance="22uF" footprint="0805" pcbX={-15} pcbY={-9.3} schSectionName="Power" schX={-8} schY={7} schRotation={270} />
    <trace from="C1.pin1" to="net.V5" thickness="0.4mm" />
    <trace from="C1.pin2" to="net.GND" />
    <trace from="C2.pin1" to="net.V3_3" thickness="0.4mm" />
    <trace from="C2.pin2" to="net.GND" />

    {/* ---------------- MCU ---------------- */}
    <ESP32_S3_WROOM_1_N16R8 name="U2" pcbX={0} pcbY={5.5} schSectionName="MCU" schX={5} schY={2} />
    <trace from="U2.3V3" to="net.V3_3" thickness="0.4mm" />
    <trace from="U2.GND1" to="net.GND" />
    <trace from="U2.GND2" to="net.GND" />
    <trace from="U2.GND3" to="net.GND" />
    {/* Desacoplamento junto ao pino 3V3 do módulo */}
    <capacitor name="C3" capacitance="10uF" footprint="0805" pcbX={-12} pcbY={10.5} schSectionName="Power" schX={-7} schY={7} schRotation={270} />
    <capacitor name="C4" capacitance="100nF" footprint="0402" pcbX={-11.8} pcbY={13.3} schSectionName="Power" schX={-6} schY={7} schRotation={270} />
    <trace from="C3.pin1" to="net.V3_3" thickness="0.4mm" />
    <trace from="C3.pin2" to="net.GND" />
    <trace from="C4.pin1" to="net.V3_3" thickness="0.4mm" />
    <trace from="C4.pin2" to="net.GND" />

    {/* EN: RC de power-on (10 kΩ + 1 µF), recomendação do datasheet do WROOM-1 */}
    <resistor name="R3" resistance="10k" footprint="0402" pcbX={-15} pcbY={8} schSectionName="MCU" schX={-1} schY={2} schRotation={270} />
    <capacitor name="C5" capacitance="1uF" footprint="0402" pcbX={-12} pcbY={7.5} schSectionName="MCU" schX={0} schY={0} schRotation={270} />
    <trace from="R3.pin1" to="net.V3_3" thickness="0.4mm" />
    <trace from="R3.pin2" to="net.EN" />
    <trace from="C5.pin1" to="net.EN" />
    <trace from="C5.pin2" to="net.GND" />
    <trace from="U2.EN" to="net.EN" />

    {/* USB nativa (USB Serial/JTAG — o firmware usa ARDUINO_USB_MODE=1) */}
    <trace from="U2.IO19" to="net.USB_DM" />
    <trace from="U2.IO20" to="net.USB_DP" />
    <trace from="J1.DM1" to="net.USB_DM" />
    <trace from="J1.DM2" to="net.USB_DM" />
    <trace from="J1.DP1" to="net.USB_DP" />
    <trace from="J1.DP2" to="net.USB_DP" />

    {/* ---------------- Botões ---------------- */}
    {/* TS-1187A: A–B e C–D são ligados internamente; a tecla fecha A/B com C/D */}
    <TS_1187A_B_A_B name="SW1" pcbX={-15} pcbY={0} schSectionName="UI" schX={21} schY={6} />
    <trace from="SW1.A" to="net.EN" />
    <trace from="SW1.C" to="net.GND" />
    {/* B e D já são ligados a A e C por dentro; ligar os dois deixa o DRC do KiCad limpo */}
    <trace from="SW1.B" to="net.EN" />
    <trace from="SW1.D" to="net.GND" />

    <TS_1187A_B_A_B name="SW2" pcbX={15} pcbY={-6} schSectionName="UI" schX={21} schY={3} />
    <resistor name="R4" resistance="10k" footprint="0402" pcbX={12} pcbY={-1} schSectionName="UI" schX={19} schY={3} schRotation={270} />
    <trace from="R4.pin1" to="net.V3_3" thickness="0.4mm" />
    <trace from="R4.pin2" to="net.BOOT" />
    <trace from="U2.IO0" to="net.BOOT" />
    <trace from="SW2.A" to="net.BOOT" />
    <trace from="SW2.C" to="net.GND" />
    {/* B e D já são ligados a A e C por dentro; ligar os dois deixa o DRC do KiCad limpo */}
    <trace from="SW2.B" to="net.BOOT" />
    <trace from="SW2.D" to="net.GND" />

    {/* Botão de usuário: pull-up interno do ESP32 */}
    <TS_1187A_B_A_B name="SW3" pcbX={15} pcbY={-13} schSectionName="UI" schX={21} schY={0} />
    <trace from={`U2.${USER_BTN}`} to="SW3.A" />
    <trace from="SW3.C" to="net.GND" />
    <trace from="SW3.B" to="SW3.A" />
    <trace from="SW3.D" to="net.GND" />

    {/* ---------------- LED RGB ---------------- */}
    {/* S6-3528RGBTA: ânodos 5=R, 4=G, 6=B; cátodos 2=R, 3=G, 1=B. Cátodos no GND =
        cátodo comum, nível alto acende — igual ao LED da protoboard. Resistores
        conforme PINAGEM_EPICO_2 §4: 300 Ω no vermelho (Vf ~2 V), 100 Ω em G/B (Vf ~3 V). */}
    <S6_3528RGBTA name="D1" pcbX={0} pcbY={-10} schSectionName="UI" schX={19} schY={-5} />
    <resistor name="R5" resistance="300" footprint="0402" pcbX={-3} pcbY={-7} schSectionName="UI" schX={16} schY={-4} />
    <resistor name="R6" resistance="100" footprint="0402" pcbX={0} pcbY={-7} schSectionName="UI" schX={16} schY={-5} />
    <resistor name="R7" resistance="100" footprint="0402" pcbX={3} pcbY={-7} schSectionName="UI" schX={16} schY={-6} />
    <trace from={`U2.${LED_R}`} to="R5.pin1" />
    <trace from={`U2.${LED_G}`} to="R6.pin1" />
    <trace from={`U2.${LED_B}`} to="R7.pin1" />
    <trace from="R5.pin2" to="D1.R_A" />
    <trace from="R6.pin2" to="D1.G_A" />
    <trace from="R7.pin2" to="D1.B_A" />
    <trace from="D1.R_K" to="net.GND" />
    <trace from="D1.G_K" to="net.GND" />
    <trace from="D1.B_K" to="net.GND" />

    {/* ---------------- Áudio (módulos em barra de pinos) ---------------- */}
    {/* J2 — INMP441 (cabo curto: afasta o microfone do alto-falante) */}
    <pinheader
      name="J2"
      pinCount={6}
      pitch="2.54mm"
      gender="female"
      showSilkscreenPinLabels
      pinLabels={["VDD", "GND", "SD", "WS", "SCK", "LR"]}
      pcbX={-22}
      pcbY={-2}
      pcbRotation={90}
      schWidth={0.485}
      schSectionName="Audio"
      schX={-14}
      schY={-5}
    />
    <trace from="J2.VDD" to="net.V3_3" thickness="0.4mm" />
    <trace from="J2.GND" to="net.GND" />
    <trace from="J2.LR" to="net.GND" />
    <trace from="J2.SD" to={`U2.${MIC_SD}`} />
    <trace from="J2.WS" to={`U2.${MIC_WS}`} />
    <trace from="J2.SCK" to={`U2.${MIC_SCK}`} />

    {/* J3 — MAX98357A, mesma ordem da breakout comum (LRC BCLK DIN GAIN SD GND VIN).
        GAIN e SD ficam abertos: 9 dB e amplificador habilitado (PINAGEM_EPICO_2 §3). */}
    <pinheader
      name="J3"
      pinCount={7}
      pitch="2.54mm"
      gender="female"
      showSilkscreenPinLabels
      pinLabels={["LRC", "BCLK", "DIN", "GAIN", "SD", "GND", "VIN"]}
      pcbX={22}
      pcbY={-2}
      pcbRotation={90}
      schWidth={0.58}
      schSectionName="Audio"
      schX={-14}
      schY={-10}
    />
    <trace from="J3.LRC" to={`U2.${SPK_LRC}`} />
    <trace from="J3.BCLK" to={`U2.${SPK_BCLK}`} />
    <trace from="J3.DIN" to={`U2.${SPK_DIN}`} />
    <trace from="J3.GND" to="net.GND" />
    <trace from="J3.VIN" to="net.V5" thickness="0.4mm" />

    {/* ---------------- Mecânica ---------------- */}
    {/* Antena do WROOM-1 na borda superior: nada de cobre dos lados dela (guia de
        hardware da Espressif). O módulo cobre a área sob a antena. */}
    <keepout shape="rect" pcbX={-17.4} pcbY={19.25} width="15mm" height="6.5mm" layers={["top", "bottom"]} />
    <keepout shape="rect" pcbX={17.4} pcbY={19.25} width="15mm" height="6.5mm" layers={["top", "bottom"]} />
    {/* Plano de GND nas duas faces: retorno curto para o I2S e para os picos de RF */}
    <copperpour connectsTo="net.GND" layer="top" clearance="0.25mm" />
    <copperpour connectsTo="net.GND" layer="bottom" clearance="0.25mm" />
    <hole diameter="3.2mm" pcbX={-21.5} pcbY={-19} />
    <hole diameter="3.2mm" pcbX={21.5} pcbY={-19} />
  </board>
)
