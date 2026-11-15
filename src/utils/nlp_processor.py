import sys
import json
import collections
# pyrefly: ignore [missing-import]
import spacy

_cached_nlp = None

def get_nlp():
    global _cached_nlp
    if _cached_nlp is not None:
        return _cached_nlp, None
    try:
        _cached_nlp = spacy.load("en_core_web_sm")
        return _cached_nlp, None
    except Exception as e:
        return None, str(e)

def analyze_text(text, nlp_instance=None):
    if not text.strip():
        return {
            "sentenceCount": 0,
            "wordCount": 0,
            "uniqueWordCount": 0,
            "passiveVoiceCount": 0,
            "subordinateClausesCount": 0,
            "avgSentenceLength": 0,
            "repeatedWords": [],
            "lexicalDiversity": {"ttr": None, "hdd": None, "mtld": None}
        }

    if nlp_instance is not None:
        nlp = nlp_instance
    else:
        nlp, err = get_nlp()
        if nlp is None:
            return {"error": f"Failed to load spaCy model: {err}"}

    doc = nlp(text)

    # 1. Sentences
    sentences = list(doc.sents)
    sentence_count = len(sentences)

    # 2. Words & Tokens (filtering punctuation & spaces)
    words = [t for t in doc if not t.is_punct and not t.is_space]
    word_count = len(words)
    
    unique_words = set(t.text.lower() for t in words)
    unique_word_count = len(unique_words)

    # 3. Passive Voice Detection
    # In spaCy, passive constructions feature an auxiliary passive dependency relation ("auxpass")
    passive_voice_count = sum(1 for token in doc if token.dep_ == "auxpass")

    # 4. Subordinate Clauses
    # Include finite and non-finite subordinate clauses, including relative clauses.
    subordinate_clause_deps = {"advcl", "acl", "relcl", "ccomp", "xcomp", "csubj", "csubjpass"}
    subordinate_clauses_count = sum(1 for token in doc if token.dep_ in subordinate_clause_deps)

    # 5. Average Sentence Length
    avg_sentence_length = round(word_count / sentence_count, 1) if sentence_count > 0 else 0

    # 5b. Lexical Diversity Calculations (TTR, HD-D, MTLD)
    tokens = [t.text.lower() for t in words]
    token_count = len(tokens)
    
    ttr = round(unique_word_count / token_count, 2) if token_count > 0 else None
    mtld = None
    hdd = None
    
    if token_count >= 10:
        threshold = 0.72
        
        def compute_mtld_dir(word_list):
            factor_count = 0.0
            start_idx = 0
            unique_seg = set()
            
            for idx, word in enumerate(word_list):
                unique_seg.add(word)
                seg_len = idx - start_idx + 1
                cur_ttr = len(unique_seg) / seg_len
                
                if cur_ttr < threshold and seg_len > 1:
                    factor_count += 1.0
                    unique_seg = set()
                    start_idx = idx + 1
                    
            final_len = len(word_list) - start_idx
            if final_len > 0:
                final_unique = set(word_list[start_idx:])
                final_ttr = len(final_unique) / final_len
                if final_ttr < 1.0:
                    fraction = (1.0 - final_ttr) / (1.0 - threshold)
                    factor_count += fraction
                    
            return len(word_list) / factor_count if factor_count > 0 else len(word_list)
            
        mtld_forward = compute_mtld_dir(tokens)
        mtld_backward = compute_mtld_dir(list(reversed(tokens)))
        mtld = round((mtld_forward + mtld_backward) / 2.0, 1)

        sample_size = 42
        if token_count >= sample_size:
            freqs = collections.Counter(tokens)
            expected_unique = 0.0
            for word, c in freqs.items():
                ratio = 1.0
                for j in range(sample_size):
                    ratio *= (token_count - c - j) / (token_count - j)
                expected_unique += (1.0 - ratio)
            hdd = round(expected_unique / sample_size, 2)

    # 6. Repeated Words Detection (excluding functional stop words, but allowing overused descriptors like 'very')
    allowed_stops = {"very", "really", "so", "good", "great", "many", "much", "more", "most", "always", "never", "often", "sometimes"}
    content_words = [
        t.text.lower() for t in words 
        if (not t.is_stop or t.text.lower() in allowed_stops) 
        and t.pos_ in ["NOUN", "PROPN", "VERB", "ADJ", "ADV"] 
        and len(t.text) >= 3 
        and not t.like_num
    ]
    
    word_freqs = collections.Counter(content_words)
    repeated_words = []
    
    for word, count in word_freqs.items():
        # A content word is flagged as over-repeated if it appears >= 4 times 
        # AND represents at least 1.5% of total words in the text.
        percentage = (count / word_count) * 100 if word_count > 0 else 0
        if count >= 4 and percentage >= 1.5:
            repeated_words.append({
                "word": word,
                "count": count
            })
            
    # Sort repeated words by count descending
    repeated_words.sort(key=lambda x: x["count"], reverse=True)

    return {
        "sentenceCount": sentence_count,
        "wordCount": word_count,
        "uniqueWordCount": unique_word_count,
        "passiveVoiceCount": passive_voice_count,
        "subordinateClausesCount": subordinate_clauses_count,
        "avgSentenceLength": avg_sentence_length,
        "repeatedWords": repeated_words,
        "lexicalDiversity": {
            "ttr": ttr,
            "hdd": hdd,
            "mtld": mtld
        }
    }

if __name__ == "__main__":
    try:
        # Read from stdin
        input_text = sys.stdin.read()
        analysis = analyze_text(input_text)
        print(json.dumps(analysis))
    except Exception as e:
        print(json.dumps({"error": str(e)}))
