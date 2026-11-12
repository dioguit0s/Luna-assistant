import type { ChipProps } from "@tscircuit/props"

// Pinagem conferida no datasheet TUOZHAN (LCSC C2843672): ânodos 6/5/4 = B/R/G,
// cátodos 1/2/3 = B/R/G. O import do JLC trouxe só "pinN".
const pinLabels = {
  pin1: ["B_K"],
  pin2: ["R_K"],
  pin3: ["G_K"],
  pin4: ["G_A"],
  pin5: ["R_A"],
  pin6: ["B_A"]
} as const

export const S6_3528RGBTA = (props: ChipProps<typeof pinLabels>) => {
  return (
    <chip
      pinLabels={pinLabels}
      supplierPartNumbers={{
  "jlcpcb": [
    "C2843672"
  ]
}}
      manufacturerPartNumber="S6-3528RGBTA"
      footprint="dfn6_p1mm_w3.8502mm_pw0.55mm_pl0.9mm_pin1location(leftside,bottom)"
      cadModel={{
        objUrl: "https://modelcdn.tscircuit.com/easyeda_models/assets/C2843672.obj?uuid=e252463fa80f4eda85c16b4ef4c560f4",
        stepUrl: "https://modelcdn.tscircuit.com/easyeda_models/assets/C2843672.step?uuid=e252463fa80f4eda85c16b4ef4c560f4",
        pcbRotationOffset: 0,
        modelOriginPosition: { x: 0, y: 0.000012699999842880061, z: -0.04 },
      }}
      {...props}
    />
  )
}