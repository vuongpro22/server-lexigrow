const seedData = [
  {
    slug: 'daily-life',
    title: 'Daily Life & Routines',
    description: 'Master essential expressions for daily routines, commuting to work/school, and household shopping.',
    level: 'A2',
    category: 'Daily Life',
    status: 'published',
    items: [
      { word: 'routine', partOfSpeech: 'noun', definitionVi: 'thói quen, công việc hàng ngày', phonetic: '/ruːˈtiːn/', collocations: ['daily routine', 'morning routine', 'routine task'], exampleSentences: ['My daily routine includes a morning jog.', 'She has a strict routine for studying.'], quizQuestions: [{ type: 'multiple-choice', question: 'What does "routine" mean in Vietnamese?', options: ['thói quen', 'kỹ năng', 'mục tiêu', 'công việc'], correctAnswer: 'thói quen' }, { type: 'fill-in-blank', question: 'My _____ routine includes a morning jog.', options: ['daily', 'weekly', 'monthly', 'yearly'], correctAnswer: 'daily' }] },
      { word: 'commute', partOfSpeech: 'verb', definitionVi: 'đi lại (giữa nhà và nơi làm việc)', phonetic: '/kəˈmjuːt/', collocations: ['daily commute', 'commute to work', 'commute time'], exampleSentences: ['I commute to work by bus every day.', 'Her commute takes about an hour.'], quizQuestions: [{ type: 'multiple-choice', question: 'What does "commute" mean?', options: ['đi bộ', 'đi lại giữa nhà và nơi làm việc', 'du lịch', 'chạy bộ'], correctAnswer: 'đi lại giữa nhà và nơi làm việc' }] },
      { word: 'grocery', partOfSpeech: 'noun', definitionVi: 'hàng tạp hóa, thực phẩm', phonetic: '/ˈɡroʊsəri/', collocations: ['grocery store', 'grocery list', 'grocery shopping'], exampleSentences: ['I need to buy some groceries for dinner.', 'She made a grocery list before going to the store.'], quizQuestions: [] },
    ],
  },
  {
    slug: 'travel',
    title: 'Travel & Exploration',
    description: 'Describe famous landmarks, detailed travel itineraries, and reserving hotel rooms.',
    level: 'B1', category: 'Travel', status: 'published',
    items: [
      { word: 'itinerary', partOfSpeech: 'noun', definitionVi: 'lịch trình, kế hoạch chuyến đi', phonetic: '/aɪˈtɪnəreri/', collocations: ['travel itinerary', 'daily itinerary', 'planned itinerary'], exampleSentences: ['Our travel itinerary includes visits to three cities.', 'She planned a detailed itinerary for the trip.'], quizQuestions: [{ type: 'multiple-choice', question: 'What does "itinerary" mean?', options: ['vé máy bay', 'lịch trình chuyến đi', 'khách sạn', 'hộ chiếu'], correctAnswer: 'lịch trình chuyến đi' }] },
      { word: 'accommodation', partOfSpeech: 'noun', definitionVi: 'chỗ ở, nơi lưu trú', phonetic: '/əˌkɑːməˈdeɪʃn/', collocations: ['hotel accommodation', 'find accommodation', 'book accommodation'], exampleSentences: ['We need to book accommodation for our trip.', 'The city offers many types of accommodation.'], quizQuestions: [{ type: 'multiple-choice', question: 'What is "accommodation"?', options: ['phương tiện đi lại', 'chỗ ở', 'đồ ăn', 'giải trí'], correctAnswer: 'chỗ ở' }] },
      { word: 'landmark', partOfSpeech: 'noun', definitionVi: 'địa danh nổi tiếng, cột mốc', phonetic: '/ˈlændmɑːrk/', collocations: ['famous landmark', 'historical landmark', 'visit a landmark'], exampleSentences: ['The Eiffel Tower is a famous landmark in Paris.', 'We visited several landmarks during our tour.'], quizQuestions: [] },
    ],
  },
  {
    slug: 'hobbies',
    title: 'Hobbies & Creative Arts',
    description: 'Express passion for photography, cooking, gardening, and work-life balance.', level: 'B1', category: 'Hobbies', status: 'published',
    items: [
      { word: 'photography', partOfSpeech: 'noun', definitionVi: 'nhiếp ảnh, nghệ thuật chụp ảnh', phonetic: '/fəˈtɑːɡrəfi/', collocations: ['digital photography', 'photography class', 'photography hobby'], exampleSentences: ['She enjoys photography and takes pictures of nature.', 'Photography is a popular hobby among travelers.'], quizQuestions: [{ type: 'multiple-choice', question: 'What does "photography" mean?', options: ['vẽ tranh', 'nhiếp ảnh', 'đan len', 'làm vườn'], correctAnswer: 'nhiếp ảnh' }] },
      { word: 'gardening', partOfSpeech: 'noun', definitionVi: 'làm vườn, nghề trồng trọt', phonetic: '/ˈɡɑːrdnɪŋ/', collocations: ['gardening hobby', 'gardening tools', 'gardening tips'], exampleSentences: ['My grandmother loves gardening and grows beautiful flowers.', 'Gardening is a relaxing and rewarding activity.'], quizQuestions: [{ type: 'multiple-choice', question: 'What is "gardening"?', options: ['nấu ăn', 'làm vườn', 'chạy bộ', 'bơi lội'], correctAnswer: 'làm vườn' }] },
      { word: 'cooking', partOfSpeech: 'noun', definitionVi: 'nấu ăn', phonetic: '/ˈkʊkɪŋ/', collocations: ['cooking class', 'cooking skills', 'cooking hobby'], exampleSentences: ['She took a cooking class to improve her skills.', 'Cooking is a creative and useful hobby.'], quizQuestions: [] },
    ],
  },
  {
    slug: 'technology', title: 'Technology & Innovation', description: 'Discuss AI algorithms, software automation, and next-generation technological breakthroughs.', level: 'B1', category: 'Technology', status: 'published',
    items: [
      { word: 'algorithm', partOfSpeech: 'noun', definitionVi: 'thuật toán, các bước logic giải quyết vấn đề', phonetic: '/ˈælɡərɪðəm/', collocations: ['search algorithm', 'algorithm design', 'sorting algorithm'], exampleSentences: ['The search engine relies on a sophisticated algorithm to rank results.', 'Students learned how to write an efficient sorting algorithm.'], quizQuestions: [{ type: 'multiple-choice', question: 'What does "algorithm" mean?', options: ['thuật toán', 'phần cứng', 'mạng máy tính', 'màn hình'], correctAnswer: 'thuật toán' }] },
      { word: 'automation', partOfSpeech: 'noun', definitionVi: 'sự tự động hóa trong quy trình và sản xuất', phonetic: '/ˌɑːtəˈmeɪʃn/', collocations: ['process automation', 'industrial automation', 'test automation'], exampleSentences: ['Automation helps companies increase efficiency and eliminate manual errors.', 'The factory introduced robotics and automation on the assembly line.'], quizQuestions: [{ type: 'multiple-choice', question: 'What is "automation"?', options: ['tự động hóa', 'lập trình thủ công', 'bán hàng', 'quảng cáo'], correctAnswer: 'tự động hóa' }] },
      { word: 'breakthrough', partOfSpeech: 'noun', definitionVi: 'bước đột phá quan trọng', phonetic: '/ˈbreɪkθruː/', collocations: ['technological breakthrough', 'major breakthrough', 'scientific breakthrough'], exampleSentences: ['Generative AI marks a remarkable technological breakthrough.', 'Scientists announced a major breakthrough in renewable battery technology.'], quizQuestions: [{ type: 'multiple-choice', question: 'What is a "breakthrough"?', options: ['bước đột phá', 'sự cố kỹ thuật', 'lỗi lập trình', 'kế hoạch trì hoãn'], correctAnswer: 'bước đột phá' }] },
    ],
  },
  {
    slug: 'business', title: 'Business & Global Economy', description: 'Apply business vocabulary for financial negotiations, revenue growth, and corporate strategy.', level: 'B2', category: 'Business', status: 'published',
    items: [
      { word: 'revenue', partOfSpeech: 'noun', definitionVi: 'doanh thu, tổng thu nhập kinh doanh', phonetic: '/ˈrevənuː/', collocations: ['annual revenue', 'generate revenue', 'revenue growth'], exampleSentences: ['The tech company reported strong revenue growth in the third quarter.', 'Subscription models help startups generate predictable recurring revenue.'], quizQuestions: [{ type: 'multiple-choice', question: 'What does "revenue" mean in business?', options: ['doanh thu', 'chi phí', 'khoản nợ', 'tiền phạt'], correctAnswer: 'doanh thu' }] },
      { word: 'negotiation', partOfSpeech: 'noun', definitionVi: 'sự đàm phán, thương lượng hợp đồng', phonetic: '/nɪˌɡoʊʃiˈeɪʃn/', collocations: ['contract negotiation', 'peaceful negotiation', 'successful negotiation'], exampleSentences: ['After weeks of intense negotiation, both companies signed the merger deal.', 'Good listening skills are essential for win-win negotiation.'], quizQuestions: [{ type: 'multiple-choice', question: 'What does "negotiation" mean?', options: ['đàm phán thương lượng', 'ký séc', 'sa thải nhân viên', 'quảng bá sản phẩm'], correctAnswer: 'đàm phán thương lượng' }] },
      { word: 'strategy', partOfSpeech: 'noun', definitionVi: 'chiến lược, kế hoạch hành động dài hạn', phonetic: '/ˈstrætədʒi/', collocations: ['business strategy', 'marketing strategy', 'long-term strategy'], exampleSentences: ['The executive board outlined a comprehensive strategy for overseas expansion.', 'Our digital marketing strategy significantly enhanced brand awareness.'], quizQuestions: [{ type: 'multiple-choice', question: 'What is a "strategy"?', options: ['chiến lược hành động', 'báo cáo tài chính', 'hóa đơn bán lẻ', 'lịch làm việc'], correctAnswer: 'chiến lược hành động' }] },
    ],
  },
  {
    slug: 'environment', title: 'Environment & Sustainability', description: 'Discuss biodiversity, climate action, ecosystem preservation, and clean renewable energy.', level: 'B1', category: 'Environment', status: 'published',
    items: [
      { word: 'ecosystem', partOfSpeech: 'noun', definitionVi: 'hệ sinh thái tự nhiên', phonetic: '/ˈiːkoʊsɪstəm/', collocations: ['marine ecosystem', 'fragile ecosystem', 'ecosystem preservation'], exampleSentences: ['Plastic waste presents a severe hazard to the marine ecosystem.', 'Wetlands form an indispensable ecosystem that filters freshwater.'], quizQuestions: [{ type: 'multiple-choice', question: 'What is an "ecosystem"?', options: ['hệ sinh thái', 'nhà máy năng lượng', 'thời tiết cực đoan', 'tài nguyên khoáng sản'], correctAnswer: 'hệ sinh thái' }] },
      { word: 'renewable', partOfSpeech: 'adjective', definitionVi: 'tái tạo được, có thể tái sinh', phonetic: '/rɪˈnuːəbl/', collocations: ['renewable energy', 'renewable resource', 'renewable power'], exampleSentences: ['The city committed to generating all municipal power from renewable sources.', 'Solar and wind power are key forms of renewable electricity.'], quizQuestions: [{ type: 'multiple-choice', question: 'What does "renewable" describe?', options: ['năng lượng có thể tái tạo', 'chất thải độc hại', 'nhiên liệu hóa thạch', 'khí thải nhà kính'], correctAnswer: 'năng lượng có thể tái tạo' }] },
      { word: 'conservation', partOfSpeech: 'noun', definitionVi: 'sự bảo tồn thiên nhiên và tài nguyên', phonetic: '/ˌkɑːnsərˈveɪʃn/', collocations: ['wildlife conservation', 'nature conservation', 'energy conservation'], exampleSentences: ['Local communities actively participate in wildlife conservation programs.', 'Energy conservation habits reduce both carbon emissions and power bills.'], quizQuestions: [{ type: 'multiple-choice', question: 'What is "conservation"?', options: ['sự bảo tồn, giữ gìn', 'sự khai thác triệt để', 'sự phá hủy rừng', 'sự xả rác'], correctAnswer: 'sự bảo tồn, giữ gìn' }] },
    ],
  },
]

export default seedData
