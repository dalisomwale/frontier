// Zambia's 116 districts by province (as gazetted up to 2018, current in
// 2021; source: Districts of Zambia, Wikipedia). Shared by the browser (the
// district lists on forms) and the server (checking a district belongs to
// its province), so both always agree.
(function (root) {
  const DISTRICTS = {
    "Central": ["Chibombo", "Chisamba", "Chitambo", "Kabwe", "Kapiri Mposhi", "Luano", "Mkushi", "Mumbwa", "Ngabwe", "Serenje", "Shibuyunji"],
    "Copperbelt": ["Chililabombwe", "Chingola", "Kalulushi", "Kitwe", "Luanshya", "Lufwanyama", "Masaiti", "Mpongwe", "Mufulira", "Ndola"],
    "Eastern": ["Chadiza", "Chama", "Chasefu", "Chipangali", "Chipata", "Kasenengwa", "Katete", "Lumezi", "Lundazi", "Lusangazi", "Mambwe", "Nyimba", "Petauke", "Sinda", "Vubwi"],
    "Luapula": ["Chembe", "Chiengi", "Chifunabuli", "Chipili", "Kawambwa", "Lunga", "Mansa", "Milenge", "Mwansabombwe", "Mwense", "Nchelenge", "Samfya"],
    "Lusaka": ["Chilanga", "Chongwe", "Kafue", "Luangwa", "Lusaka", "Rufunsa"],
    "Muchinga": ["Chinsali", "Isoka", "Kanchibiya", "Lavushimanda", "Mafinga", "Mpika", "Nakonde", "Shiwang'andu"],
    "Northern": ["Chilubi", "Kaputa", "Kasama", "Lunte", "Lupososhi", "Luwingu", "Mbala", "Mporokoso", "Mpulungu", "Mungwi", "Nsama", "Senga"],
    "North-Western": ["Chavuma", "Ikelenge", "Kabompo", "Kasempa", "Kalumbila", "Manyinga", "Mufumbwe", "Mushindamo", "Mwinilunga", "Solwezi", "Zambezi"],
    "Southern": ["Chikankata", "Chirundu", "Choma", "Gwembe", "Itezhi-Tezhi", "Kalomo", "Kazungula", "Livingstone", "Mazabuka", "Monze", "Namwala", "Pemba", "Siavonga", "Sinazongwe", "Zimba"],
    "Western": ["Kalabo", "Kaoma", "Limulunga", "Luampa", "Lukulu", "Mitete", "Mongu", "Mulobezi", "Mwandi", "Nalolo", "Nkeyema", "Senanga", "Sesheke", "Shang'ombo", "Sikongo", "Sioma"],
  };
  const key = (s) => String(s || "").toLowerCase().replace(/[^a-z]/g, "");
  // The districts of a province (empty for an unknown province).
  const list = (province) => DISTRICTS[province] || [];
  // The district's proper spelling when it belongs to the province, or null.
  function match(province, district) {
    const k = key(district);
    return list(province).find((d) => key(d) === k) || null;
  }
  // The province a district is in, or null.
  function provinceOf(district) {
    const k = key(district);
    return Object.keys(DISTRICTS).find((p) => DISTRICTS[p].some((d) => key(d) === k)) || null;
  }
  // A province name as written elsewhere ("North Western", "LUSAKA") -> ours.
  function province(name) {
    const k = key(name);
    return Object.keys(DISTRICTS).find((p) => key(p) === k) || null;
  }
  const api = { DISTRICTS, list, match, provinceOf, province };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.ZambiaDistricts = api;
})(typeof window !== "undefined" ? window : globalThis);
